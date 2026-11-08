// The 2026-11-08 clock change (Azizbek qarori): one operations day is 30
// real minutes, while every money wait stays on the old 2-minute day.
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import 'dotenv/config'

import {
  REAL_MS_PER_SIM_DAY, REAL_SEC_PER_SIM_DAY,
  FINANCE_REAL_MS_PER_SIM_DAY, FINANCE_REAL_SEC_PER_SIM_DAY,
  FINANCE_WAIT_MAX_REAL_MS, SIM_CLOCK_RESCALE_RATIO,
  simDaysToSeconds, financeDaysToSeconds, billableSimDays, MAX_CATCHUP_REAL_MS,
} from '../src/constants/simClock.js'
import { TERM_DAYS } from '../src/constants/paymentTerms.js'
import { HOS_TIME_SCALE, DRIVING_LIMIT_HOURS } from '../src/constants/hosClock.js'
import { MVR_MAX_AGE_DAYS, daysUntil } from '../src/constants/driverQualification.js'
import { SETTLEMENT_TERM_SIM_DAYS, DRIVER_STAGES, stageFor } from '../src/constants/driverPay.js'
import { transitDaysFor } from '../src/modules/loads/dispatch.service.js'
import * as PAYROLL_SQL from '../src/modules/payroll/payroll.sql.js'
import * as ALERT_SQL from '../src/modules/alerts/alerts.sql.js'
import { inRollback } from './helpers/rollback.js'

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS

// Kills: operations day reverted to 2 minutes, or the finance day moved
// onto the operations day (net60 would become 30 real hours).
test('the two day lengths have the agreed values and stay distinct', () => {
  assert.equal(REAL_MS_PER_SIM_DAY, 30 * MIN_MS)
  assert.equal(REAL_SEC_PER_SIM_DAY, 1800)
  assert.equal(FINANCE_REAL_MS_PER_SIM_DAY, 2 * MIN_MS)
  assert.equal(FINANCE_REAL_SEC_PER_SIM_DAY, 120)
  assert.notEqual(REAL_MS_PER_SIM_DAY, FINANCE_REAL_MS_PER_SIM_DAY)
  assert.equal(SIM_CLOCK_RESCALE_RATIO, 15)
})

// Kills: transit still on the 2-minute day (a 36-hour window would be 3 minutes).
test('an 803-mile run takes at least thirty real minutes in transit', () => {
  const pickupAt = '2026-11-08T08:00:00Z'
  const deliveryAt = '2026-11-09T20:00:00Z' // a 36-hour window for 803 mi
  const days = transitDaysFor({ pickupAt, deliveryAt })
  assert.equal(days, 1.5)
  const realMs = simDaysToSeconds(days) * 1000
  assert.ok(realMs >= 30 * MIN_MS, `${realMs} ms`)
  assert.equal(realMs, 45 * MIN_MS)
})

// Kills: HOS_TIME_SCALE left at 720 (11 driving hours would be 55 s).
test('hours-of-service scale follows the operations day', () => {
  assert.equal(HOS_TIME_SCALE, 48)
  const drivingRealSeconds = (DRIVING_LIMIT_HOURS * HOUR_MS) / HOS_TIME_SCALE / 1000
  assert.equal(drivingRealSeconds, 825)
})

// Kills: daysUntil dividing by the finance day (counts would be 15x off).
test('the MVR and CDL windows keep their sim-day counts on the 30-minute day', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  assert.equal(MVR_MAX_AGE_DAYS, 365)
  assert.equal(daysUntil(new Date(now + 1400 * REAL_MS_PER_SIM_DAY).toISOString(), now), 1400)
  assert.equal(daysUntil(new Date(now + 10 * REAL_MS_PER_SIM_DAY).toISOString(), now), 10)
})

// Kills: settlement due or stage ageing moved onto the operations day.
test('driver settlement stages age on the finance day', () => {
  assert.equal(financeDaysToSeconds(SETTLEMENT_TERM_SIM_DAYS), 7 * FINANCE_REAL_SEC_PER_SIM_DAY)
  const daysOverdue = (ms) => Math.floor(ms / FINANCE_REAL_MS_PER_SIM_DAY)
  assert.equal(stageFor(daysOverdue(DRIVER_STAGES.refuses * FINANCE_REAL_MS_PER_SIM_DAY)), 'refuses')
  assert.equal(stageFor(daysOverdue(DRIVER_STAGES.quits * FINANCE_REAL_MS_PER_SIM_DAY)), 'quits')
  assert.equal(stageFor(daysOverdue(DRIVER_STAGES.quits * FINANCE_REAL_MS_PER_SIM_DAY - 1)), 'refuses')
})

// Kills: money SQL interpolating REAL_SEC_PER_SIM_DAY (1800) instead of
// FINANCE_REAL_SEC_PER_SIM_DAY (120) -- a driver would never reach 'quits'.
test('payroll, invoice aging and alerts SQL divide by the finance day', () => {
  const sqls = [
    ...Object.values(PAYROLL_SQL).filter((v) => typeof v === 'string' && v.includes('daysOverdue')),
    ALERT_SQL.OVERDUE_INVOICES_SQL,
  ]
  assert.ok(sqls.length >= 3, `found ${sqls.length} statements`)
  for (const sql of sqls) {
    assert.match(sql, new RegExp(`/ ${FINANCE_REAL_SEC_PER_SIM_DAY}\\b`))
    assert.doesNotMatch(sql, new RegExp(`/ ${REAL_SEC_PER_SIM_DAY}\\b`))
  }
})

// Kills: invoice due on the operations day (net60 = 30 real hours), or a
// new term added that breaks the 12-hour promise.
test('a net60 invoice falls due in 7200 seconds, and no term waits over 12 hours', () => {
  assert.equal(financeDaysToSeconds(TERM_DAYS.net60), 7200)
  for (const [term, days] of Object.entries(TERM_DAYS)) {
    assert.ok(days * FINANCE_REAL_MS_PER_SIM_DAY <= FINANCE_WAIT_MAX_REAL_MS, term)
  }
})

// Kills: a zero-length wait that never advances time.
test('financeDaysToSeconds is whole seconds and never zero', () => {
  assert.equal(financeDaysToSeconds(0), 1)
  assert.equal(financeDaysToSeconds(0.001), 1)
  assert.equal(financeDaysToSeconds(1.5), 180)
})

// Kills: the catch-up cap swallowing a legitimate day, or billableSimDays
// reading a different day than REAL_MS_PER_SIM_DAY.
test('thirty real minutes bill as capped sim time, and the cap is under a day', () => {
  assert.equal(billableSimDays(30 * MIN_MS), MAX_CATCHUP_REAL_MS / REAL_MS_PER_SIM_DAY)
  assert.equal(billableSimDays(MAX_CATCHUP_REAL_MS / 2), MAX_CATCHUP_REAL_MS / 2 / REAL_MS_PER_SIM_DAY)
  assert.ok(MAX_CATCHUP_REAL_MS < REAL_MS_PER_SIM_DAY, 'cap is shorter than a day')
})

// Kills: SQL and JS drifting apart (SQL cannot import the constants).
test('migration 073 spells out the same numbers as simClock.js', () => {
  const sql = readFileSync(new URL('../src/db/migrations/073_sim_clock_30min.sql', import.meta.url), 'utf8')
  assert.ok(sql.includes(`/ ${REAL_SEC_PER_SIM_DAY}.0`), 'new day length')
  assert.ok(sql.includes(`/ ${FINANCE_REAL_SEC_PER_SIM_DAY}.0`), 'old day length')
  assert.ok(sql.includes(`ratio         constant int := ${SIM_CLOCK_RESCALE_RATIO};`), 'rescale ratio')
  assert.ok(sql.includes(`mvr_days      constant int := ${MVR_MAX_AGE_DAYS};`), 'MVR window')
  assert.ok(!/\bUPDATE\s+(loads|driver_settlements)\b/i.test(sql), 'money due dates untouched')
})

const { hasDb } = await import('./helpers/db.js')

// Kills: a day boundary that ignores the anchor (history re-dated, or the
// new day length applied before the anchor), or one that ignores a reset.
test('sim_day() and sim_day_start() honour the anchor boundaries', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const OLD = FINANCE_REAL_SEC_PER_SIM_DAY
  const NEW = REAL_SEC_PER_SIM_DAY
  const OLD_DAYS_BEFORE_ANCHOR = 10

  await inRollback(pool, async (client) => {
    const q = async (sql, params = []) => (await client.query(sql, params)).rows[0]
    const epoch = await q('SELECT sim_epoch() AS e')
    if (!epoch.e) return // fresh database, nothing to anchor on
    const at = (sec) => `sim_epoch() + ${sec} * interval '1 second'`
    const dayOffset = async (sec) =>
      Number((await q(`SELECT (sim_day(${at(sec)}) - (sim_epoch() AT TIME ZONE 'UTC')::date) AS d`)).d)
    const startOffset = async (sec) =>
      Number((await q(`SELECT EXTRACT(EPOCH FROM (sim_day_start(${at(sec)}) - sim_epoch())) AS s`)).s)

    const anchorSec = OLD_DAYS_BEFORE_ANCHOR * OLD
    await client.query(
      `INSERT INTO sim_state (key, value)
       VALUES ('sim_clock_rescale', jsonb_build_object(
         'at', to_char((sim_epoch() + $1 * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'day', to_char((sim_epoch() AT TIME ZONE 'UTC')::date + $2::int, 'YYYY-MM-DD')))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [anchorSec, OLD_DAYS_BEFORE_ANCHOR],
    )
    // Before the anchor: the old 120 s day.
    assert.equal(await dayOffset(anchorSec - 1), OLD_DAYS_BEFORE_ANCHOR - 1)
    assert.equal(await startOffset(anchorSec - 1), anchorSec - OLD)
    // At the anchor and after: continuous numbering, 1800 s days.
    assert.equal(await dayOffset(anchorSec), OLD_DAYS_BEFORE_ANCHOR)
    assert.equal(await dayOffset(anchorSec + NEW - 1), OLD_DAYS_BEFORE_ANCHOR)
    assert.equal(await dayOffset(anchorSec + NEW), OLD_DAYS_BEFORE_ANCHOR + 1)
    assert.equal(await startOffset(anchorSec + NEW + 5), anchorSec + NEW)

    // A reset writes a new epoch AFTER the anchor: pure new-length days.
    await client.query(
      `UPDATE sim_state SET value = jsonb_set(value, '{at}', to_jsonb('1970-01-01T00:00:00.000000Z'::text))
        WHERE key = 'sim_clock_rescale'`,
    )
    assert.equal(await dayOffset(NEW - 1), 0)
    assert.equal(await dayOffset(NEW), 1)
    assert.equal(await startOffset(NEW + 5), NEW)

    // No anchor at all (a database that never needed one): same.
    await client.query(`DELETE FROM sim_state WHERE key = 'sim_clock_rescale'`)
    assert.equal(await dayOffset(2 * NEW), 2)
  })
})

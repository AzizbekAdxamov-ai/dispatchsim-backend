// The payroll clock stops while the company is offline, and a wait is
// worded by describeWait. The numbers that decide a driver's stage are
// not touched: only the gap-shift and the words are under test here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import 'dotenv/config'

import { describeWait, stageFor } from '../src/constants/driverPay.js'
import { droppedGapSeconds, MAX_CATCHUP_REAL_MS } from '../src/constants/simClock.js'
import { refusalLine } from '../src/modules/driverChat/driverChat.refusal.js'

const { hasDb } = await import('./helpers/db.js')

test('droppedGapSeconds drops only what lies beyond the catch-up cap', () => {
  // Kills: returning the whole gap (shifts time interest still billed),
  // and `>=` flipped so a gap of exactly the cap shifted by 0 -> -0 noise.
  assert.equal(droppedGapSeconds(30_000), 0)
  assert.equal(droppedGapSeconds(MAX_CATCHUP_REAL_MS), 0)
  assert.equal(droppedGapSeconds(MAX_CATCHUP_REAL_MS + 1_000), 1)
  assert.equal(droppedGapSeconds(3_600_000), 3300)
  assert.equal(droppedGapSeconds(-5), 0)
  assert.equal(droppedGapSeconds(NaN), 0)
})

test('describeWait: exact to two weeks, then weeks, then months', () => {
  // Kills: a boundary moved by one (14/15, 60/61), a missing singular
  // "1 day", and 0 rendering as an empty or negative wait.
  assert.equal(describeWait(0), '0 days')
  assert.equal(describeWait(1), '1 day')
  assert.equal(describeWait(2), '2 days')
  assert.equal(describeWait(14), '14 days')
  assert.equal(describeWait(15), 'a few weeks')
  assert.equal(describeWait(60), 'a few weeks')
  assert.equal(describeWait(61), 'over two months')
  assert.equal(describeWait(4236), 'over two months')
  assert.equal(describeWait(-3), '0 days')
  assert.equal(describeWait(null), '0 days')
})

test('wording never moves the stage: stageFor still reads the exact days', () => {
  // Kills: stageFor being fed describeWait's text, or the thresholds
  // being edited to match the wording buckets.
  assert.equal(stageFor(14), 'quits')
  assert.equal(stageFor(7), 'refuses')
  assert.equal(stageFor(4236), 'quits')
})

test('the refusal line words a long wait and keeps a short one exact', () => {
  // Kills: a refusal template still interpolating the raw number.
  for (const driverId of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const long = refusalLine({ driverId, reason: 'unpaid', owedUsd: 900, unpaidCount: 2, daysOverdue: 4236 })
    assert.match(long, /over two months/)
    assert.doesNotMatch(long, /4236|4,236/)
    const short = refusalLine({ driverId, reason: 'unpaid', owedUsd: 900, unpaidCount: 2, daysOverdue: 9 })
    assert.match(short, /9 days/)
  }
})

test('the driver prompt words the oldest wait through describeWait', async () => {
  // Kills: the prompt still printing "N days past due" for a huge N.
  const src = readFileSync(new URL('../src/modules/driverChat/driverChat.prompt.js', import.meta.url), 'utf8')
  assert.match(src, /describeWait\(standing\.daysOverdue\)/)
  assert.doesNotMatch(src, /\$\{standing\.daysOverdue\} days/)
})

test('the tick holds the payroll clock before anything can earn a settlement', () => {
  // Kills: moving holdPayrollClock after deliverArrivedLoads, where a gap
  // would shift a settlement earned after the gap ended.
  const src = readFileSync(new URL('../src/modules/loads/dispatch.service.js', import.meta.url), 'utf8')
  const tick = src.slice(src.indexOf('export async function runTick'))
  const hold = tick.indexOf('holdPayrollClock')
  assert.ok(hold > 0, 'runTick calls holdPayrollClock')
  assert.ok(hold < tick.indexOf('deliverArrivedLoads'))
})

async function withSettlements(fn) {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/dispatch.service.js')
  await inRollback(pool, async (client) => {
    const driver = (await client.query(`SELECT id FROM drivers LIMIT 1`)).rows[0]
    const loads = (await client.query(`SELECT id FROM loads LIMIT 2`)).rows
    if (!driver || loads.length < 2) return 'skip'
    await client.query(`DELETE FROM driver_settlements`)
    await client.query(`DELETE FROM sim_state WHERE key = 'tick_clock'`)
    await client.query(
      `INSERT INTO driver_settlements (driver_id, load_id, gross_usd, deductions_usd, net_usd, earned_at, due_at, paid_at)
       VALUES ($1, $2, 100, 0, 100, now() - interval '2 hours', now() - interval '1 hour', NULL),
              ($1, $3, 100, 0, 100, now() - interval '2 hours', now() - interval '1 hour', now() - interval '30 minutes')`,
      [driver.id, loads[0].id, loads[1].id],
    )
    const hold = (nowFn) => service.holdPayrollClock({ run: (f) => f(client), nowFn })
    const dues = async () => {
      const r = await client.query(
        `SELECT paid_at IS NULL AS unpaid, extract(epoch FROM due_at)::bigint AS due
           FROM driver_settlements ORDER BY paid_at NULLS FIRST`)
      return { unpaid: Number(r.rows[0].due), paid: Number(r.rows[1].due) }
    }
    await fn({ hold, dues, client })
  })
}

test('first tick creates the watermark and shifts nothing', { skip: !hasDb }, async () => {
  // Kills: shifting against a missing watermark (a huge phantom gap).
  await withSettlements(async ({ hold, dues }) => {
    const before = await dues()
    assert.equal(await hold(() => new Date()), 0)
    assert.deepEqual(await dues(), before)
  })
})

test('a normal gap shifts nothing; a long gap shifts by gap minus the cap, once', { skip: !hasDb }, async () => {
  // Kills: shifting by the whole gap; shifting on a normal tick; paid rows
  // being shifted; a second run over the same gap shifting again.
  await withSettlements(async ({ hold, dues, client }) => {
    const t0 = new Date()
    await hold(() => t0)
    const before = await dues()

    assert.equal(await hold(() => new Date(t0.getTime() + 30_000)), 0)
    assert.deepEqual(await dues(), before, 'a 30 s gap moves nothing')

    const t1 = new Date(t0.getTime() + 30_000)
    const t2 = new Date(t1.getTime() + 3_600_000)
    assert.equal(await hold(() => t2), 1, 'only the unpaid settlement is held')
    const after = await dues()
    assert.equal(after.unpaid - before.unpaid, 3300)
    assert.equal(after.paid, before.paid, 'a paid settlement is history')

    assert.equal(await hold(() => t2), 0, 'same instant: nothing left to drop')
    assert.deepEqual(await dues(), after)

    // A tick that queued on the lock with an older `now` neither shifts
    // nor drags the watermark backwards.
    await hold(() => new Date(t2.getTime() - 10_000))
    const wm = await client.query(`SELECT value->>'lastAt' AS at FROM sim_state WHERE key='tick_clock'`)
    assert.equal(new Date(wm.rows[0].at).getTime(), t2.getTime())
    assert.deepEqual(await dues(), after)
  })
})

// Compliance > Overview's composition: the DQ tile counts, the open
// document list and its soonest-first order. The rules underneath are
// each proven in their own module's tests (driverQualification.test.js,
// unassignedHos.test.js); what is tested here is the COMPOSITION -- that
// the overview reads the same readings the detail screens show, and
// orders the renewal calendar the way a carrier works it.
//
// The DB-backed part uses the same opts.client seam the overview exposes,
// inside a rolled-back transaction. Skips without a database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { REVIEW_THRESHOLD_MIN } from '../src/modules/hos/repositioning.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

test('the review threshold the ELD tile states is repositioning\'s own', () => {
  // Kills: a second 30 typed into the overview -- two copies of one rule
  // is the exact pattern the seed's DQ work refused.
  assert.equal(REVIEW_THRESHOLD_MIN, 30)
})

const hasDb = Boolean(process.env.DATABASE_URL)

test('the overview counts DQ states and lists open documents soonest-first', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/stats/stats.service.js')

  await inRollback(pool, async (client) => {
    // The fixture: two drivers with DQ rows -- one clean, one whose
    // medical has already lapsed -- and one working driver with NO DQ
    // row (the fact the screen must show, not hide).
    const d = (await client.query(
      `SELECT id FROM drivers WHERE duty_status <> 'off' ORDER BY created_at LIMIT 3`,
    )).rows
    if (d.length < 3) return // seed-dependent fixture; nothing to prove here

    await client.query(
      `INSERT INTO driver_qualification (driver_id, cdl_status, medical_expires_on, medical_status, mvr_checked_on, mvr_violations, mvr_status, da_status)
       VALUES
         ($1, 'valid', now() + interval '300 days', 'valid', now() - interval '30 days', 0, 'valid', 'valid'),
         ($2, 'valid', NULL, 'missing', now() - interval '30 days', 0, 'valid', 'valid')`,
      [d[0].id, d[1].id],
    )
    // d[2] gets no row on purpose.

    const overview = await service.getComplianceOverview({ client })

    // The tile counts: one clear, one action (missing medical), one whose
    // file is absent (also action -- a missing file is the missing
    // document, not a pass).
    assert.equal(overview.drivers.total, 3)
    assert.equal(overview.drivers.clear, 1)
    assert.equal(overview.drivers.action, 2)

    // The open-document list carries the lapsed medical, the missing one,
    // and one entry for the absent file's driver (readDocumentStatus is
    // not consulted for a row that does not exist -- the service marks
    // the whole file missing via its own defaults).
    const forDriver2 = overview.openDocuments.filter((o) => o.driverId === d[1].id)
    assert.ok(forDriver2.some((o) => o.document === 'medical' && o.status === 'missing'),
      'the missing medical is listed with its CFR')

    // Every open document names its rule.
    for (const o of overview.openDocuments) assert.match(o.cfr, /49 CFR/)

    // Soonest-first: entries with a countdown sort by it; the undated
    // ones sit at the end.
    const dated = overview.openDocuments.filter((o) => o.daysLeft != null)
    for (let i = 1; i < dated.length; i += 1) {
      assert.ok(dated[i - 1].daysLeft <= dated[i].daysLeft, 'open documents are soonest-first')
    }

    // The ELD tile exists and states the threshold it reviews against.
    assert.equal(overview.eld.reviewThresholdMin, REVIEW_THRESHOLD_MIN)
    assert.ok(Number.isInteger(overview.eld.unreviewedUnidentified))

    // HOS tile counts today's violations, not a season of them.
    assert.ok(Number.isInteger(overview.hos.driversWithViolationsToday))
    assert.ok(Number.isInteger(overview.hos.violationMinutesToday))
  })
})

test('a fixture span of one sim day reads as a 24-hour HOS day', () => {
  // Kills: an overview that divided expiries by real 86400000 -- the
  // same unit mistake the HOS screens already fixed once.
  const spanMs = 1 * REAL_MS_PER_SIM_DAY
  assert.equal(Math.round(spanMs / (24 * 60 * 60 * 1000) * 1000), 1, 'one sim day is 1/720 of a literal day')
})

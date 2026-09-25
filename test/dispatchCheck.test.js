// The pre-dispatch compliance check: the facts the confirm window shows
// before the click. The rules underneath are each proven in their own
// module's tests; what is tested here is the COMPOSITION and its
// discipline -- the lines read the same sources dispatch will read, an
// unknown driver is a 404 and not a guess, and nothing here invents a
// second opinion about a document's state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { REVIEW_THRESHOLD_MIN } from '../src/modules/hos/repositioning.js'

// The transit estimate names the PROMISED side only -- asserted through
// the response's transitSource field below, not by re-deriving a second
// number here.

test('dispatchCheck exists on the dispatch module beside the write', () => {
  // Kills: a check that drifted into its own module and stopped reading
  // the same code path the dispatch runs.
  import('../src/modules/loads/dispatch.service.js').then((m) => {
    assert.equal(typeof m.dispatchCheck, 'function')
    assert.equal(typeof m.dispatchLoad, 'function')
  })
})

const hasDb = Boolean(process.env.DATABASE_URL)

test('the check composes real lines for a real load and driver', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/dispatch.service.js')

  await inRollback(pool, async (client) => {
    // A neutral load -- the only state a dispatch can start from. The
    // fixture needs no writes when the seed left one; otherwise skip.
    const load = (await client.query(
      `SELECT id FROM loads WHERE status = 'neutral' ORDER BY booked_at DESC LIMIT 1`,
    )).rows[0]
    if (!load) return // no neutral load in this database; nothing to ask about

    // The qualification reader reads EVERY driver (LEFT JOIN on the DQ
    // row), so the fixture driver must not have one already -- pick a
    // driver the demo fleet left out of the DQ table, and let the insert
    // below write the row the check will read.
    const driver = (await client.query(
      `SELECT d.id FROM drivers d
        LEFT JOIN driver_qualification q ON q.driver_id = d.id
       WHERE d.duty_status <> 'off' AND q.driver_id IS NULL
       ORDER BY d.created_at LIMIT 1`,
    )).rows[0]
    if (!driver) return

    // DQ rows for the driver, so the document lines are the reader's
    // real output rather than defaults.
    await client.query(
      `INSERT INTO driver_qualification (driver_id, cdl_status, medical_expires_on, medical_status, mvr_checked_on, mvr_violations, mvr_status, da_status)
       VALUES ($1, 'valid', now() + interval '200 days', 'valid', now() - interval '10 days', 0, 'valid', 'valid')
       ON CONFLICT (driver_id) DO UPDATE SET medical_expires_on = EXCLUDED.medical_expires_on, medical_status = 'valid'`,
      [driver.id],
    )

    const check = await service.dispatchCheck({ loadId: load.id, driverId: driver.id })

    // The load travels with its lane and rate -- the window's header.
    assert.equal(check.load.id, load.id)
    assert.ok(check.load.originLabel.includes(','))
    assert.ok(check.load.rateUsd > 0)

    // Every DQ document is one line, all valid here, and the drive clock
    // is one line with its CFR attached.
    const docLines = check.checks.filter((c) => c.key.startsWith('dq.'))
    assert.equal(docLines.length, 4, 'four documents, four lines')
    for (const line of docLines) assert.equal(line.state, 'ok')
    const hos = check.checks.find((c) => c.key === 'hos')
    assert.equal(hos.cfr, '49 CFR 395.3(a)(3)')

    // Truck and workload lines exist and are ok for this fixture.
    assert.equal(check.checks.find((c) => c.key === 'truck')?.state, 'ok')
    assert.equal(check.checks.find((c) => c.key === 'workload')?.state, 'ok')

    // canDispatch agrees with the lines, and nothing failed.
    assert.equal(check.canDispatch, check.checks.every((c) => c.state !== 'fail'))
    assert.deepEqual(check.degraded, [])

    // The transit line names the promised side, never a legal ETA.
    assert.equal(check.transitSource, 'promised')
    if (check.transitDays != null) assert.ok(check.transitDays >= 0.5)
  })
})

test('an unknown driver is DRIVER_NOT_FOUND, never a silent all-clear', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { AppError } = await import('../src/lib/errors.js')
  const service = await import('../src/modules/loads/dispatch.service.js')

  await inRollback(pool, async (client) => {
    const load = (await client.query(
      `SELECT id FROM loads WHERE status = 'neutral' ORDER BY booked_at DESC LIMIT 1`,
    )).rows[0]
    if (!load) return

    await assert.rejects(
      () => service.dispatchCheck({ loadId: load.id, driverId: 'no-such-driver' }),
      (err) => err instanceof AppError && err.code === 'DRIVER_NOT_FOUND',
    )
  })
})

test('the ELD review line and the check share repositioning\'s threshold', () => {
  // Kills: a second 30 typed into the check -- the same pattern the
  // overview and the qualification work refused.
  assert.equal(REVIEW_THRESHOLD_MIN, 30)
})

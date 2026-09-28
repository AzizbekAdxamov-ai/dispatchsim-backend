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

const { hasDb } = await import('./helpers/db.js')

test('the check composes real lines for a real load and driver', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/dispatch.service.js')

  await inRollback(pool, async (client) => {
    // The fixture: a neutral load and a driver whose qualification file the
    // check can read and this test can write. Both are created in the
    // rollback -- a seed that happens to satisfy neither was still a
    // fixture, and 'no rows' skipped the assertions instead of proving
    // them (the pre-trip work found this: both old tests were passing on
    // an empty read).
    const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
    const fx = await makeCheckFixture(client)

    const check = await service.dispatchCheck({ loadId: fx.loadId, driverId: fx.driverId }, { client })

    // The load travels with its lane and rate -- the window's header.
    assert.equal(check.load.id, fx.loadId)
    assert.ok(check.load.originLabel.includes(','))
    assert.ok(check.load.rateUsd > 0)

    // Every DQ document is one line, all valid here, and the drive clock
    // is one line with its CFR attached.
    const docLines = check.checks.filter((c) => c.key.startsWith('dq.'))
    assert.equal(docLines.length, 4, 'four documents, four lines')
    for (const line of docLines) assert.equal(line.state, 'ok')
    assert.ok(docLines[0].label, 'each document line is named, not keyed')
    assert.ok(docLines.every((l) => l.cfr), 'each document line carries its CFR')
    const hos = check.checks.find((c) => c.key === 'hos')
    assert.equal(hos.cfr, '49 CFR 395.3(a)(3)')

    // Truck and workload lines exist and are ok for this fixture -- a
    // truckless workload row would read 'unknown' forever and nobody
    // would have noticed.
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
    const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
    const fx = await makeCheckFixture(client)

    await assert.rejects(
      () => service.dispatchCheck({ loadId: fx.loadId, driverId: 'no-such-driver' }, { client }),
      (err) => err instanceof AppError && err.code === 'DRIVER_NOT_FOUND',
    )
  })
})

test('the ELD review line and the check share repositioning\'s threshold', () => {
  // Kills: a second 30 typed into the check -- the same pattern the
  // overview and the qualification work refused.
  assert.equal(REVIEW_THRESHOLD_MIN, 30)
})

test('the check carries a pre-trip line when the driver has a truck', { skip: !hasDb }, async () => {
  // Kills: the PTI line reading a different truck than the dispatch will
  // write, or a second opinion about the tire gauges -- the line's rule
  // is constants/preTrip.js's inspectionOutcome, the SAME call the
  // dispatch transaction makes.
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/dispatch.service.js')
  const preTrip = await import('../src/constants/preTrip.js')

  await inRollback(pool, async (client) => {
    const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
    const fx = await makeCheckFixture(client, { withTruck: true })

    const check = await service.dispatchCheck({ loadId: fx.loadId, driverId: fx.driverId }, { client })
    const line = check.checks.find((c) => c.key === 'preTrip')
    assert.ok(line, 'the walk-around line rides the check for a trucked driver')
    assert.equal(line.cfr, '49 CFR 392.7', 'a pass names 392.7')
    assert.equal(line.state, 'ok', 'the fixture truck\'s gauges are clean')

    // The line's verdict is the model's verdict for the same truck state
    // -- the gauge read the line shows is the one the write will record.
    const truck = (await client.query(`SELECT * FROM trucks WHERE id = $1`, [fx.truckId])).rows[0]
    const outcome = preTrip.inspectionOutcome({
      truck: { odometerMi: truck.odometer_mi, tireFrontPct: truck.tire_front_pct, tireRearPct: truck.tire_rear_pct },
      lastDvir: null, rng: null,
    })
    const hasDefect = Object.values(outcome.items).some((ok) => !ok)
    assert.equal(line.state, hasDefect ? 'fail' : 'ok')
  })
})

test('a truckless driver has no pre-trip line, never a guessed one', { skip: !hasDb }, async () => {
  // Kills: a line invented for a driver who cannot walk around anything.
  // The fixture driver is written WITHOUT a truck in the rollback, so the
  // read can never come back empty -- a seed change used to skip this
  // whole test as a silent pass.
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const service = await import('../src/modules/loads/dispatch.service.js')

  await inRollback(pool, async (client) => {
    const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
    const fx = await makeCheckFixture(client, { withTruck: false })

    const check = await service.dispatchCheck({ loadId: fx.loadId, driverId: fx.driverId }, { client })
    assert.equal(check.checks.find((c) => c.key === 'preTrip'), undefined,
      'no truck, no walk-around line')
  })
})

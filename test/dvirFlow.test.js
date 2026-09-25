// The DVIR flow against the real schema, inside a rolled-back
// transaction: the builder's row inserts cleanly, the list reads it
// back with its certification decision, the certify write clears the
// hold, and migration 041's CHECK pair (dvir_correction_certified) enforces
// the model's claim: corrected means defects existed and were certified.
// Skips without a database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const hasDb = Boolean(process.env.DATABASE_URL)

test('a built report inserts, reads, and certifies per 396.13', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const dvirService = await import('../src/modules/fleet/dvir.service.js')
  const dvirRepo = await import('../src/modules/fleet/dvir.repository.js')
  const { seeded } = await import('./helpers/rng.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    // The certify rule pairs the report's truck with its CURRENT driver,
    // so the fixture driver must be one the fleet has not put on a truck
    // yet -- the demo fleet leaves most of its drivers truckless.
    const driver = (await client.query(
      `SELECT d.id FROM drivers d
        LEFT JOIN trucks t ON t.driver_id = d.id
       WHERE d.duty_status <> 'off' AND t.id IS NULL
       ORDER BY d.created_at LIMIT 1`,
    )).rows[0]
    if (!truck || !driver) {
      t.skip('truck or truckless driver missing from this database')
      return
    }

    // The defect case: a truck the gauges say failed the tire item.
    const row = dvirService.buildReportRow({
      rng: seeded(21),
      truck: { id: truck.id, odometerMi: 250000, tireFrontPct: 15, tireRearPct: 60 },
      driverId: driver.id,
      loadId: null,
      locationLabel: 'Memphis, TN',
      hadBreakdown: false,
    })
    assert.equal(row.tiresOk, false, 'the gauge says defect')
    assert.equal(row.defectsCorrected, false)

    // The INSERT returns its id, but it rides a transaction the runner
    // never sees; the row's identity is read back off the same client.
    await dvirRepo.insertReport(client, row)
    const exposed = (await client.query(`SELECT id FROM dvir_reports ORDER BY id DESC LIMIT 1`)).rows[0]
    assert.ok(exposed?.id, 'the row lands')

    // The list read carries the certification decision: defects open ->
    // not allowed, with the rule named. The read runs on the test's own
    // connection, inside the transaction that wrote the row.
    const list = await dvirService.listReports({ limit: 50 }, client)
    const read = list.reports.find((r) => r.id === exposed.id)
    assert.ok(read, 'the report is in the list')
    assert.equal(read.certification.allowed, false)
    assert.equal(read.certification.cfr, '49 CFR 396.13(b)(2)')

    // Certification requires the truck's CURRENT driver. Assign the
    // driver, then certify: the hold clears.
    await client.query(`UPDATE trucks SET driver_id = $1 WHERE id = $2`, [driver.id, truck.id])
    const certified = await dvirService.certifyReport({ reportId: exposed.id, driverId: driver.id }, client)
    assert.equal(certified.certified, true)

    // A second certify is already-done, not a second certification.
    await assert.rejects(
      () => dvirService.certifyReport({ reportId: exposed.id, driverId: driver.id }, client),
      (err) => err && err.code === 'SERVICE_ALREADY_DONE',
    )

    // The list read now carries the certified state: defects listed,
    // certification written, no hold left.
    const listAfter = await dvirService.listReports({ limit: 50 }, client)
    const readAfter = listAfter.reports.find((r) => r.id === exposed.id)
    assert.ok(readAfter, 'the certified report is in the list')
    assert.equal(readAfter.certification.allowed, true)
    assert.equal(readAfter.certifiedBy?.id, driver.id, 'the certification names its driver')

    // A non-driver is refused with the assignment error.
    const row2 = dvirService.buildReportRow({
      rng: seeded(22),
      truck: { id: truck.id, odometerMi: 251000, tireFrontPct: 10, tireRearPct: 60 },
      driverId: driver.id,
      loadId: null,
      locationLabel: null,
      hadBreakdown: false,
    })
    await dvirRepo.insertReport(client, row2)
    const exposed2 = (await client.query(`SELECT id FROM dvir_reports ORDER BY id DESC LIMIT 1`)).rows[0]
    await assert.rejects(
      () => dvirService.certifyReport({ reportId: exposed2.id, driverId: 'someone-else' }, client),
      (err) => err && (err.code === 'TRUCK_HAS_DRIVER' || err.code === 'SERVICE_NOT_FOUND'),
      'the certifier must be the truck\'s current driver',
    )
  })
})

test('the CHECK pair holds: a defect report born "corrected" is refused', { skip: !hasDb }, async () => {
  // The model says a defect report is BORN defects_corrected=false -- the
  // correction duty exists precisely in that state -- and only the 396.13
  // sign-off flips the flag. Migration 041's dvir_correction_certified
  // CHECK is the other half of that pair (040's dvir_defects_need_correction
  // had it backwards: it refused every freshly born defect report, which
  // killed each defect-bearing delivery in the tick, and admitted a report
  // certified for nothing). Each lie has its own transaction: one failed
  // statement aborts the transaction it ran in, and a second attempt in an
  // aborted transaction fails with a different error the CHECK test cannot
  // name.
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) return

    await assert.rejects(
      () => client.query(
        `INSERT INTO dvir_reports (truck_id, odometer_mi, brakes_ok, lights_ok, tires_ok,
           steering_ok, coupling_ok, horn_ok, wipers_ok, mirrors_ok, emergency_eq_ok,
           defects, defects_corrected)
         VALUES ($1, 1000, true, true, false, true, true, true, true, true, true,
           $2::jsonb, true)`,
        [truck.id, JSON.stringify([{ item: 'tires', detail: 'x' }])],
      ),
      (err) => /dvir_correction_certified/.test(err.message),
      'a defect report born "corrected" is a lie the CHECK refuses',
    )
  })
})

test('the CHECK pair holds: a clean report certified for nothing is refused', { skip: !hasDb }, async () => {
  // The other half: corrected=true names a certification of EXISTING
  // defects -- a certified empty report has nothing behind the signature.
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) return

    await assert.rejects(
      () => client.query(
        `INSERT INTO dvir_reports (truck_id, odometer_mi, brakes_ok, lights_ok, tires_ok,
           steering_ok, coupling_ok, horn_ok, wipers_ok, mirrors_ok, emergency_eq_ok,
           defects, defects_corrected, certified_at)
         VALUES ($1, 1000, true, true, true, true, true, true, true, true, true,
           '[]'::jsonb, true, now())`,
        [truck.id],
      ),
      (err) => /dvir_correction_certified/.test(err.message),
      'a clean report certified for nothing is a lie too',
    )
  })
})

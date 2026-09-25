// The DVIR flow against the real schema, inside a rolled-back
// transaction: the builder's row inserts cleanly, the list reads it
// back with its certification decision, the certify write clears the
// hold, and migration 040's own CHECKs enforce the pair (defects need
// correction) the model claims. Skips without a database.
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
    const driver = (await client.query(
      `SELECT id FROM drivers WHERE duty_status <> 'off' ORDER BY created_at LIMIT 1`,
    )).rows[0]
    if (!truck || !driver) {
      t.skip('truck or driver missing from this database')
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

    const inserted = await dvirRepo.insertReport(client, row)
    assert.ok(inserted?.id, 'the row lands')

    // The list read carries the certification decision: defects open ->
    // not allowed, with the rule named.
    const list = await dvirService.listReports({ limit: 50 })
    const read = list.reports.find((r) => r.id === inserted.id)
    assert.ok(read, 'the report is in the list')
    assert.equal(read.certification.allowed, false)
    assert.equal(read.certification.cfr, '49 CFR 396.13(b)(2)')

    // Certification requires the truck's CURRENT driver. Assign the
    // driver, then certify: the hold clears.
    await client.query(`UPDATE trucks SET driver_id = $1 WHERE id = $2`, [driver.id, truck.id])
    const certified = await dvirService.certifyReport({ reportId: inserted.id, driverId: driver.id })
    assert.equal(certified.certified, true)

    // A second certify is already-done, not a second certification.
    await assert.rejects(
      () => dvirService.certifyReport({ reportId: inserted.id, driverId: driver.id }),
      (err) => err && err.code === 'SERVICE_ALREADY_DONE',
    )

    // A non-driver is refused with the assignment error.
    const row2 = dvirService.buildReportRow({
      rng: seeded(22),
      truck: { id: truck.id, odometerMi: 251000, tireFrontPct: 10, tireRearPct: 60 },
      driverId: driver.id,
      loadId: null,
      locationLabel: null,
      hadBreakdown: false,
    })
    const inserted2 = await dvirRepo.insertReport(client, row2)
    await assert.rejects(
      () => dvirService.certifyReport({ reportId: inserted2.id, driverId: 'someone-else' }),
      (err) => err && err.code === 'TRUCK_HAS_DRIVER',
    )
  })
})

test('the CHECK pair holds: defects without correction are refused by the database', { skip: !hasDb }, async () => {
  // The model says a defect report carries defects_corrected=false; the
  // migration's dvir_defects_need_correction CHECK is the other half.
  // A report whose defects are marked corrected IN THE INSERT is a lie
  // the database refuses.
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
      (err) => /dvir_defects_need_correction/.test(err.message),
      'a defect report born "corrected" is a lie the CHECK refuses',
    )
  })
})

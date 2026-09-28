// The pre-trip flow against the real schema, inside a rolled-back
// transaction: the built row inserts cleanly, the re-dispatch conflict
// guard holds, migration 045's defects-array CHECK refuses a non-array,
// and the walk-around block never overlaps the repositioning drive.
// Skips without a database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')
const { inRollback } = await import('./helpers/rollback.js')

// A load fixture with its own broker, deleted with the test's rollback.
// Every load id is unique -- the table's generator dedupes against live
// rows, not against other fixtures in the same run.
async function fixtureLoad(client, id) {
  await client.query(
    `INSERT INTO loads (id, broker, rate_usd, distance_mi, origin_city, origin_state,
       destination_city, destination_state, payment_terms, status, pickup_at, delivery_at,
       weight_lbs, equipment_type, equipment_length_ft, booked_at)
     VALUES ($1, 'PTI Test Broker', 2000, 500, 'Dallas', 'TX', 'Memphis', 'TN', 'net30', 'neutral',
       now() + interval '120 seconds', now() + interval '240 seconds',
       28000, 'dry-van', 53, now())`,
    [id],
  )
  return id
}

test('a built inspection inserts, and a re-dispatch writes no second row', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { buildInspectionRow } = await import('../src/constants/preTrip.js')
  const preTripRepo = await import('../src/modules/fleet/preTrip.repository.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) {
      t.skip('truck missing from this database')
      return
    }
    const loadId = await fixtureLoad(client, '990101')

    const outcome = {
      items: Object.fromEntries([
        'brakes', 'lights', 'tires', 'steering', 'coupling', 'horn',
        'wipers', 'mirrors', 'emergencyEq', 'parkingBrake', 'wheelsRims',
      ].map((k) => [k, true])),
      defects: [{ item: 'tires', detail: 'Steer tread below 25%' }],
      notes: [],
    }
    outcome.items.tires = false

    const row = buildInspectionRow({
      truckId: truck.id,
      driverId: null,
      loadId,
      odometerMi: 250000,
      outcome,
      reviewedDvirId: null,
    })
    assert.equal(row.tiresOk, false, 'the finding rides the row')

    await preTripRepo.insertInspection(client, row)
    const written = (await client.query(
      `SELECT id, truck_id AS "truckId", defects, reviewed_dvir_id AS "reviewedDvirId"
         FROM pre_trip_inspections WHERE load_id = $1`,
      [loadId],
    )).rows[0]
    assert.ok(written?.id, 'the row lands')
    assert.equal(written.truckId, truck.id)
    assert.deepEqual(written.defects, [{ item: 'tires', detail: 'Steer tread below 25%' }])

    // The same load again: the unique index makes the duplicate a no-op.
    await preTripRepo.insertInspection(client, row)
    const count = (await client.query(
      `SELECT count(*)::int AS n FROM pre_trip_inspections WHERE load_id = $1`,
      [loadId],
    )).rows[0].n
    assert.equal(count, 1, 'a re-dispatch writes no second row -- the constraint, not memory')
  })
})

test('the defects column holds the report vocabulary or nothing: a non-array is refused', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')

  await inRollback(pool, async (client) => {
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) return

    await assert.rejects(
      () => client.query(
        `INSERT INTO pre_trip_inspections (truck_id, odometer_mi, brakes_ok, lights_ok, tires_ok,
           steering_ok, coupling_ok, horn_ok, wipers_ok, mirrors_ok, emergency_eq_ok,
           parking_brake_ok, wheels_rims_ok, defects)
         VALUES ($1, 1000, true, true, true, true, true, true, true, true, true, true, true, $2::jsonb)`,
        [truck.id, '{"a": 1}'],
      ),
      (err) => /pre_trip_defects_array/.test(err.message),
      'a non-array defects column is a lie the CHECK refuses',
    )
  })
})

test('the walk-around block ends where the driving it precedes begins', { skip: !hasDb }, async () => {
  // The time-ordering the plan names as the thing to catch: walk-around,
  // then the empty drive, then the load's own log -- three records on one
  // truck, never overlapping.
  const { pool } = await import('../src/db/pool.js')
  const preTrip = await import('../src/constants/preTrip.js')
  const repositioning = await import('../src/modules/hos/repositioning.js')

  await inRollback(pool, async (client) => {
    const driver = (await client.query(
      `SELECT id FROM drivers WHERE duty_status <> 'off' ORDER BY created_at LIMIT 1`,
    )).rows[0]
    if (!driver) return

    const DISPATCHED_AT = '2026-09-26T12:00:00.000Z'
    const reposition = repositioning.repositioningBlock({
      truckLocationLabel: 'Chicago, IL',
      originCity: 'Memphis', originState: 'TN',
      dispatchedAt: DISPATCHED_AT,
    })
    assert.ok(reposition, 'Chicago -> Memphis needs a repositioning record in this fixture')

    const ptiBlock = preTrip.preTripBlock({
      dispatchedAt: DISPATCHED_AT,
      defectCount: 1,
      endsAt: reposition.startedAt,
    })
    // The walk-around runs BEFORE the drive it precedes, and touches it
    // exactly at its start.
    assert.ok(ptiBlock.endedAt <= reposition.startedAt,
      'the walk-around never overlaps the repositioning drive')
    assert.ok(ptiBlock.endedAt < reposition.endedAt,
      'the drive still ends at the dispatch, after the walk-around')

    // And the write accepts both: the unique index guards same-driver
    // same-start, which these two are not.
    const truck = (await client.query(`SELECT id FROM trucks ORDER BY id LIMIT 1`)).rows[0]
    if (!truck) return
    const inserted = await client.query(
      `INSERT INTO duty_events (driver_id, truck_id, status, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [driver.id, truck.id, ptiBlock.status, ptiBlock.startedAt, ptiBlock.endedAt],
    )
    assert.ok(inserted.rows[0]?.id, 'the walk-around block lands on the log')
  })
})

// A truck whose driver is gone is parked, not working (migration 053).
//
// Azizbek, 2026-10-01: "Assign truck" listed RS-9278-CY greyed out as
// "Marked as working without a driver" and nothing could be assigned.
// Its driver had been removed; the foreign key cleared driver_id and left
// status 'active' -- a state with no way out.
//
// Every test names the mutation it kills. The database tests skip with
// no database, and run inside a transaction that is always rolled back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inRollback } from './helpers/rollback.js'
import { makeCheckFixture } from './helpers/dispatchFixture.js'
import { truckOptionsFromRows } from '../src/modules/drivers/drivers.service.js'

const { hasDb } = await import('./helpers/db.js')
const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(join(here, '..', 'src', 'db', 'migrations', '053_driverless_truck_is_parked.sql'), 'utf8')

// Kills: a migration that only guards the future and leaves the truck
// that is stuck today stuck.
test('053 parks the trucks that are already working with nobody in them', () => {
  assert.match(MIGRATION, /UPDATE trucks\s+SET status = 'idle'[^;]*WHERE status = 'active' AND driver_id IS NULL;/)
})

// Kills: the page offering a parked truck as not assignable. Once 053 has
// run, the truck in the screenshot is an idle truck and must be pickable.
test('a parked truck is offered as assignable', () => {
  const [t] = truckOptionsFromRows([{ id: 'RS-9278-CY', make: 'International', model: 'LT', year: 2024, status: 'idle' }])
  assert.equal(t.assignable, true)
  assert.equal(t.reason, null)
})

// Kills: dropping the trigger. Taking the driver off a working truck must
// leave it idle -- the same UPDATE the foreign key's SET NULL runs when a
// driver row is deleted.
test('taking the driver off a working truck parks it', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  await inRollback(pool, async (client) => {
    const { truckId } = await makeCheckFixture(client)
    await client.query('UPDATE trucks SET driver_id = NULL WHERE id = $1', [truckId])
    const { rows } = await client.query('SELECT status, driver_id FROM trucks WHERE id = $1', [truckId])
    assert.deepEqual(rows[0], { status: 'idle', driver_id: null })
  })
})

// Kills: the trigger reaching past a release. A truck in the shop stays in
// the shop when its driver is taken off it.
test('a truck in the shop stays in the shop when its driver leaves', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  await inRollback(pool, async (client) => {
    const { truckId } = await makeCheckFixture(client)
    await client.query(`UPDATE trucks SET status = 'maintenance' WHERE id = $1`, [truckId])
    await client.query('UPDATE trucks SET driver_id = NULL WHERE id = $1', [truckId])
    const { rows } = await client.query('SELECT status FROM trucks WHERE id = $1', [truckId])
    assert.equal(rows[0].status, 'maintenance')
  })
})

// Kills: dropping the CHECK, or a trigger that quietly fixes new rows. A
// new truck said to be working with nobody in it is refused, by name.
test('a new truck cannot be working with nobody in it', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  await inRollback(pool, async (client) => {
    await assert.rejects(
      () => client.query(
        `INSERT INTO trucks (id, make, model, year, status, odometer_mi,
                             tire_front_pct, tire_rear_pct, fuel_pct, fuel_gallons,
                             fuel_capacity_gal, driver_id)
         VALUES ('ZZ-0001-TX', 'Volvo', 'VNL', 2022, 'active', 1000, 85, 82, 80, 160, 200, NULL)`,
      ),
      (err) => err.code === '23514' && err.constraint === 'trucks_active_has_driver',
    )
  })
})

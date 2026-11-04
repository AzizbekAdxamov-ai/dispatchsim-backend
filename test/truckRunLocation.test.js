// The two write guards behind a delivery's location (N1): the truck label
// and the driver move. The caller builds the label from the load; these
// hold if it ever builds a bad one again ("undefined, undefined").
// Every test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyRunToTruck } from '../src/modules/fleet/trucks.repository.js'
import { moveDriverTo, claimArrivedLoads, markDelivered } from '../src/modules/loads/loads.repository.js'
import { applyRunToTruck as applyRun } from '../src/modules/loads/dispatch.service.js'
import { deliveredTo } from '../src/modules/loads/whereabouts.js'

// Index of the endedAtLabel parameter ($6) in APPLY_RUN_TO_TRUCK_SQL.
const LABEL_PARAM = 5
// Run figures that mean nothing here; the test is about the label only.
const RUN = { truckId: 'FX-0001-TX', roadMiles: 100, gallonsFromTank: 10, frontTirePoints: 1, rearTirePoints: 1 }

function recordingClient() {
  const calls = []
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] } } }
}

async function quietly(fn) {
  const warn = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = warn }
}

// Kills: removing the label guard in applyRunToTruck (4).
test('applyRunToTruck never writes a stringified undefined location', async () => {
  const bad = recordingClient()
  await quietly(() => applyRunToTruck(bad, { ...RUN, endedAtLabel: 'undefined, undefined' }))
  assert.equal(bad.calls[0].params[LABEL_PARAM], null)

  const good = recordingClient()
  await applyRunToTruck(good, { ...RUN, endedAtLabel: 'Memphis, TN' })
  assert.equal(good.calls[0].params[LABEL_PARAM], 'Memphis, TN')
})

// Kills: removing the validity guard in moveDriverTo (5).
test('moveDriverTo skips a place without city/state', async () => {
  const c = recordingClient()
  await quietly(async () => {
    await moveDriverTo(c, { driverId: 'd1', city: undefined, state: undefined, lat: 1, lon: 2, label: 'undefined, undefined' })
    await moveDriverTo(c, { driverId: 'd1', city: 'Memphis', state: 'TN', lat: NaN, lon: 2, label: 'Memphis, TN' })
  })
  assert.equal(c.calls.length, 0)
  await moveDriverTo(c, { driverId: 'd1', city: 'Memphis', state: 'TN', lat: 35.1, lon: -90, label: 'Memphis, TN' })
  assert.equal(c.calls.length, 1)
})

const { hasDb } = await import('./helpers/db.js')

// Kills: removing the destination columns from the claim SELECT -- the
// truck and driver then stay where they were after delivery.
test('a claimed delivery leaves truck and driver at the destination', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
  await inRollback(pool, async (client) => {
    const fx = await makeCheckFixture(client)
    // Dispatched and already past its ETA, earliest in the table so the
    // claim picks it first.
    await client.query(
      `UPDATE loads SET status = 'ontime', driver_id = $2, truck_id = $3,
              dispatched_at = booked_at, eta_at = '2000-01-01T00:00:00Z'
        WHERE id = $1`,
      [fx.loadId, fx.driverId, fx.truckId],
    )
    const claimed = (await claimArrivedLoads(client, 1000)).find((l) => l.id === fx.loadId)
    assert.ok(claimed, 'fixture load was not claimed')
    await markDelivered(client, { loadId: fx.loadId, dueSeconds: 60 })
    await applyRun(client, claimed)
    await moveDriverTo(client, { driverId: fx.driverId, ...deliveredTo(claimed) })

    const truck = (await client.query('SELECT current_location FROM trucks WHERE id = $1', [fx.truckId])).rows[0]
    const driver = (await client.query('SELECT current_city, current_state FROM drivers WHERE id = $1', [fx.driverId])).rows[0]
    assert.equal(truck.current_location, 'Memphis, TN')
    assert.deepEqual(driver, { current_city: 'Memphis', current_state: 'TN' })
  })
})

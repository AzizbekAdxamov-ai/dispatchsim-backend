// A cancelled load (migration 072): it cannot be dispatched, and the schema
// refuses to let it carry a driver. Database-backed, always in a rollback.
// Every test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')

// PostgreSQL SQLSTATE for a CHECK violation.
const CHECK_VIOLATION = '23514'

async function withCancelledLoad(fn) {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')
  await inRollback(pool, async (client) => {
    const fx = await makeCheckFixture(client)
    const cancelled = await loadsRepo.cancelLoad(client, { loadId: fx.loadId, reason: 'carrier_cancelled' })
    assert.equal(cancelled.id, fx.loadId)
    await fn({ client, fx, loadsRepo })
  })
}

// Kills: dispatchCheck / dispatchLoad treating a cancelled load as dispatchable
// (a status test other than status = 'neutral').
test('dispatchCheck refuses a cancelled load', { skip: !hasDb }, async () => {
  const service = await import('../src/modules/loads/dispatch.service.js')
  await withCancelledLoad(async ({ client, fx, loadsRepo }) => {
    await assert.rejects(
      service.dispatchCheck({ loadId: fx.loadId, driverId: fx.driverId }, { client }),
      (err) => err.code === 'LOAD_NOT_DISPATCHABLE',
    )
    const claimed = await loadsRepo.dispatchLoad(client, {
      loadId: fx.loadId, driverId: fx.driverId, truckId: fx.truckId, etaSeconds: 60, promisedSeconds: 60,
    })
    assert.equal(claimed, null)
  })
})

// Kills: dropping the loads_cancelled_clean CHECK from migration 072.
test('a cancelled load cannot carry a driver', { skip: !hasDb }, async () => {
  await withCancelledLoad(async ({ client, fx }) => {
    await client.query('SAVEPOINT attach')
    await assert.rejects(
      client.query('UPDATE loads SET driver_id = $2 WHERE id = $1', [fx.loadId, fx.driverId]),
      (err) => err.code === CHECK_VIOLATION,
    )
    await client.query('ROLLBACK TO SAVEPOINT attach')
  })
})

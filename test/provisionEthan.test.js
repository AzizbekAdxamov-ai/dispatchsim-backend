import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provisionEthan, SETUP } from '../scripts/provision-ethan.js'

function database({ existing = [], collision = [], load = { id: SETUP.postingId, deadheadMi: 94 }, dominant = 'dry-van', failTruck = false } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('FROM drivers d')) return { rows: existing }
      if (sql === 'SELECT id FROM trucks WHERE id = $1') return { rows: collision }
      if (sql.includes('round(road_miles')) return { rows: load ? [load] : [] }
      if (sql.includes('GROUP BY equipment_type')) return { rows: [{ equipmentType: dominant, count: 29 }] }
      if (sql.includes('nextval')) return { rows: [{ id: 'd123' }] }
      if (sql.includes('INSERT INTO drivers')) return { rows: [{ id: 'd123' }] }
      if (sql.includes('INSERT INTO trucks') && failTruck) throw new Error('truck insert failed')
      return { rows: [] }
    },
  }
}

test('default preview is read-only and does not consume an ID or create records', async () => {
  const db = database()
  const result = await provisionEthan(db)
  assert.equal(result.action, 'preview')
  assert.equal(result.load.deadheadMi, 94)
  assert.equal(result.driver.hosRemainingMin, 660)
  assert.equal(result.truck.trailerLengthFt, 53)
  assert.equal(db.calls[0].sql, 'BEGIN READ ONLY')
  assert.ok(db.calls.every(({ sql }) => !/INSERT|UPDATE|nextval|advisory/.test(sql)))
})

test('apply creates one pair using shared HR sequence and rolls back on a partial failure', async () => {
  const db = database()
  const result = await provisionEthan(db, { apply: true })
  assert.equal(result.driverId, 'd123')
  assert.equal(db.calls.filter(({ sql }) => sql.includes('INSERT INTO drivers')).length, 1)
  const truck = db.calls.find(({ sql }) => sql.includes('INSERT INTO trucks'))
  assert.deepEqual(truck.params, [SETUP.truckId, 'd123', 'Chicago, IL', 'dry-van', 53])
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  const failing = database({ failTruck: true })
  await assert.rejects(provisionEthan(failing, { apply: true }), /truck insert failed/)
  assert.equal(failing.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!failing.calls.some(({ sql }) => /INSERT INTO (loads|ledger|driver_settlements)/.test(sql)))
})

test('rerun preserves existing driver state and never creates a duplicate', async () => {
  const db = database({ existing: [{ id: 'd123', name: SETUP.name, email: SETUP.email,
    cdlNumber: SETUP.cdlNumber, truckId: SETUP.truckId,
    trailerType: SETUP.trailerType, trailerLengthFt: SETUP.trailerLengthFt }] })
  assert.equal((await provisionEthan(db, { apply: true })).action, 'already-exists')
  assert.ok(db.calls.every(({ sql }) => !/INSERT|UPDATE|nextval/.test(sql)))
})

test('stale target, wrong equipment, plate collisions and partial identities fail closed', async () => {
  for (const opts of [
    { load: null }, { load: { deadheadMi: 200 } }, { dominant: 'reefer' },
    { collision: [{ id: SETUP.truckId }] },
    { existing: [{ id: 'd123', name: SETUP.name, email: SETUP.email, truckId: null }] },
  ]) {
    const db = database(opts)
    await assert.rejects(provisionEthan(db, { apply: true }))
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
    assert.ok(db.calls.every(({ sql }) => !/INSERT|UPDATE|nextval/.test(sql)))
  }
})

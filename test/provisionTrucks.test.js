import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  provisionTrucks, parseArgs, isLocalHost, TARGET_FLEET_MIX, NEW_TRUCK_COUNT, CANDIDATES, PLATE_FORMAT,
} from '../scripts/provision-trucks.js'

// Two existing dry vans (Grace and Ethan) by default.
function database({ have = { 'dry-van': 2 }, taken = [], failOnInsert = 0 } = {}) {
  const calls = []
  let inserts = 0
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('GROUP BY trailer_type')) return { rows: Object.entries(have).map(([equipmentType, count]) => ({ equipmentType, count })) }
      if (sql.includes('id = ANY')) return { rows: taken.map((id) => ({ id })) }
      if (sql.includes('INSERT INTO trucks')) {
        inserts += 1
        if (failOnInsert === inserts) throw new Error('insert failed')
      }
      return { rows: [] }
    },
  }
}
const inserted = (db) => db.calls.filter((c) => c.sql.includes('INSERT INTO trucks'))
const verbs = (db) => db.calls.map((c) => c.sql.split(/\s+/).slice(0, 2).join(' '))
const typesOf = (result) => Object.fromEntries(Object.keys(TARGET_FLEET_MIX).map((t) => [t, result.trucks.filter((x) => x.equipmentType === t).length]))

// Kills: a dry run that writes, or one that is not read-only at the database level
test('default dry run is READ ONLY, lists 8 trucks and writes nothing', async () => {
  const db = database()
  const result = await provisionTrucks(db)
  assert.equal(result.action, 'preview')
  assert.equal(result.trucks.length, NEW_TRUCK_COUNT)
  assert.deepEqual(typesOf(result), { 'dry-van': 4, reefer: 2, flatbed: 2 })
  assert.equal(db.calls[0].sql, 'BEGIN READ ONLY')
  assert.equal(inserted(db).length, 0)
  assert.ok(!verbs(db).includes('SELECT pg_advisory_xact_lock(hashtext($1))'))
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
})

// Kills: confirm writing fewer/more trucks, assigning a driver, or touching the ledger
test('--confirm inserts 8 idle unassigned leased trucks in one transaction and no ledger entry', async () => {
  const db = database()
  const result = await provisionTrucks(db, { confirm: true })
  assert.equal(result.action, 'created')
  assert.equal(db.calls[0].sql, 'BEGIN')
  assert.equal(inserted(db).length, NEW_TRUCK_COUNT)
  assert.ok(db.calls.some((c) => c.sql.includes('pg_advisory_xact_lock')))
  for (const call of inserted(db)) {
    assert.match(call.sql, /'idle', NULL/)
    assert.match(call.sql, /true, true\)/)
    assert.match(call.params[0], PLATE_FORMAT)
  }
  assert.ok(!db.calls.some((c) => /cash_ledger/.test(c.sql)))
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
})

// Kills: a candidate list that cannot reach the target mix, or a bad plate
test('the candidates cover the mix with unique valid plates, one 48-foot flatbed', () => {
  const all = Object.values(CANDIDATES).flat()
  assert.equal(new Set(all.map((t) => t.id)).size, all.length)
  for (const t of all) assert.match(t.id, PLATE_FORMAT)
  for (const [type, target] of Object.entries(TARGET_FLEET_MIX)) assert.ok(CANDIDATES[type].length >= target, type)
  assert.deepEqual(CANDIDATES.flatbed.map((t) => t.trailerLengthFt).sort(), [48, 53])
  assert.ok([...CANDIDATES['dry-van'], ...CANDIDATES.reefer].every((t) => t.trailerLengthFt === 53))
})

// Kills: a rerun adding another 8
test('a complete fleet reports already-complete and writes nothing', async () => {
  const db = database({ have: { 'dry-van': 6, reefer: 2, flatbed: 2 } })
  const result = await provisionTrucks(db, { confirm: true })
  assert.equal(result.action, 'already-complete')
  assert.equal(inserted(db).length, 0)
})

// Kills: the mix being fixed instead of computed from what exists
test('the need is the target minus what exists', async () => {
  assert.deepEqual(typesOf(await provisionTrucks(database({ have: { 'dry-van': 2 } }))), { 'dry-van': 4, reefer: 2, flatbed: 2 })
  assert.deepEqual(typesOf(await provisionTrucks(database({ have: { 'dry-van': 1, reefer: 1 } }))), { 'dry-van': 5, reefer: 1, flatbed: 2 })
})

// Kills: writing into a fleet that does not match the plan
test('an over-target, unknown-type or wrong-total fleet throws and writes nothing', async () => {
  for (const have of [{ 'dry-van': 7 }, { 'dry-van': 2, tanker: 1 }, { 'dry-van': 2, reefer: 2, flatbed: 2 }, {}]) {
    const db = database({ have })
    await assert.rejects(provisionTrucks(db, { confirm: true }), /Fleet mix differs; nothing changed/)
    assert.equal(inserted(db).length, 0)
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  }
})

// Kills: an existing plate being skipped or overwritten instead of aborting everything
test('a plate that already exists rolls back with no insert', async () => {
  const db = database({ taken: ['TX-5101-DV'] })
  await assert.rejects(provisionTrucks(db, { confirm: true }), /already exists/)
  assert.equal(inserted(db).length, 0)
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
})

// Kills: a failure on the 4th insert leaving the first three committed
test('a failing 4th insert rolls the whole transaction back', async () => {
  const db = database({ failOnInsert: 4 })
  await assert.rejects(provisionTrucks(db, { confirm: true }), /insert failed/)
  assert.equal(inserted(db).length, 4)
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!db.calls.some((c) => c.sql === 'COMMIT'))
})

// Kills: an unknown flag acting like confirm, or a remote database touched without the flag
test('only --confirm, --dry-run and --allow-remote are accepted; remote hosts need the flag', () => {
  assert.deepEqual(parseArgs([]), { confirm: false, allowRemote: false })
  assert.deepEqual(parseArgs(['--confirm', '--allow-remote']), { confirm: true, allowRemote: true })
  assert.throws(() => parseArgs(['--apply']), /Usage/)
  assert.throws(() => parseArgs(['--confirm', '--dry-run']), /Usage/)
  assert.equal(isLocalHost('postgres://u:p@localhost:5432/db'), true)
  assert.equal(isLocalHost('postgres://u:p@127.0.0.1/db'), true)
  assert.equal(isLocalHost('postgres://u:p@db.example.com/db'), false)
})

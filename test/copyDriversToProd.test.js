// copy-drivers-to-prod: pure mapping/guard functions plus the orchestrator
// against fake clients. No real database is ever opened here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAPPING, EXPECTED_UNIQUES, PLAN, LOCK_SQL, SETVAL_SQL, parseArgs, checkHosts, classifyColumns,
  compareSchemas, mapDriver, mapDq, mapTruck, toRecord, predictReadiness, findCollisions, runCopy,
} from '../scripts/copy-drivers-to-prod.js'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const DAY = 30 * 60 * 1000

const liveColumns = () => Object.entries(MAPPING).flatMap(([table, s]) =>
  [...s.copy, ...s.reset, ...s.omit].map((c) => ({ table_name: table, column_name: c, data_type: 'text', is_nullable: 'YES' })))

const driverRow = (over = {}) => ({
  id: 'd11', name: 'Grace Lindqvist', email: 'grace@example.com', phone: '555', cdl_class: 'A',
  cdl_number: 'CDL-1', license_expires_on: new Date('2029-01-01T00:00:00Z'),
  home_base_city: 'Dallas', home_base_state: 'TX', current_location: 'Dallas, TX',
  current_city: 'Dallas', current_state: 'TX', current_lat: 32.7, current_lon: -96.8,
  duty_status: 'driving', hos_remaining_min: 12, hours_today_min: 600, hours_week_min: 3000,
  total_miles: 99999, safety_rating: 70, broker_rating_x10: 20,
  pay_model: 'permile', pay_percent_bp: null, pay_per_mile_cents: 60, bio: 'bio', preferences: { a: 1 },
  created_at: new Date(), updated_at: new Date(), ...over,
})
const dqRow = (over = {}) => ({
  driver_id: 'd11', cdl_status: 'valid', medical_expires_on: new Date(NOW + 200 * DAY),
  medical_status: 'valid', mvr_checked_on: new Date(NOW - 500 * DAY), mvr_violations: 1,
  mvr_status: 'valid', da_status: 'valid', updated_at: new Date(), ...over,
})
const truckRow = (over = {}) => ({
  id: 'RS-9278-CY', make: 'Volvo', model: 'VNL', year: 2022, odometer_mi: 1000, status: 'active',
  driver_id: 'd11', current_location: 'Dallas, TX', fuel_pct: 50, fuel_gallons: 100, fuel_capacity_gal: 200,
  last_fueled_at: null, last_fueled_location: null, tire_front_pct: 80, tire_rear_pct: 80,
  trailer_type: 'dry-van', trailer_length_ft: 53, vin: 'V'.repeat(17), engine_make: 'x', engine_model: 'y',
  horsepower: 400, transmission: 't', sleeper: 'sleeper-72', suspension: 'air-ride', axle_config: '6x4',
  wheelbase_in: 200, front_axle_lbs: 12000, rear_axle_lbs: 40000, gvwr_lbs: 52000, has_apu: true,
  location_city: 'Dallas', location_state: 'TX', created_at: new Date(), updated_at: new Date(), ...over,
})
const ethan = () => driverRow({ id: 'd118', name: 'Ethan Brooks', email: 'e@example.com', cdl_number: 'CDL-2',
  current_city: 'Chicago', current_state: 'IL', current_location: 'Chicago, IL' })
const ethanTruck = () => truckRow({ id: 'IL-2048-EB', driver_id: 'd118', vin: 'W'.repeat(17), location_city: 'Chicago', location_state: 'IL' })

const schema = (over = {}) => ({
  versions: ['001', '002'], columns: liveColumns(), uniques: [...EXPECTED_UNIQUES], ...over,
})

// ---------- pure functions ----------

test('mapDriver copies identity/persona and resets the work clock', () => {
  // Kills: copying local hours/miles/ratings, dropping bio/preferences, or leaving duty_status as local.
  const r = toRecord(mapDriver(driverRow()))
  assert.equal(r.id, 'd11')
  assert.equal(r.bio, 'bio')
  assert.deepEqual(r.preferences, { a: 1 })
  assert.equal(r.duty_status, 'on-duty')
  assert.equal(r.hos_remaining_min, 660)
  assert.equal(r.hours_today_min, 0)
  assert.equal(r.hours_week_min, 0)
  assert.equal(r.total_miles, 0)
  assert.equal(r.safety_rating, 100)
  assert.equal(r.broker_rating_x10, 50)
  assert.ok(!('created_at' in r) && !('updated_at' in r))
})

test('mapDriver refuses a driver without coordinates', () => {
  // Kills: removing the NULL lat/lon STOP (dispatch skips such drivers).
  assert.throws(() => mapDriver(driverRow({ current_lat: null })), /coordinates/)
  assert.throws(() => mapDriver(driverRow({ current_lon: null })), /coordinates/)
})

test('mapDq: Grace gets prod-now MVR, Ethan gets driver_id only', () => {
  // Kills: copying the stale local MVR date; inserting extra DQ columns for Ethan.
  const iso = '2026-11-09T12:00:00.000Z'
  const g = toRecord(mapDq(dqRow(), 'd11', iso))
  assert.equal(g.mvr_checked_on, iso)
  assert.equal(g.mvr_violations, 1)
  assert.ok(!('updated_at' in g))
  assert.deepEqual(mapDq(null, 'd118', iso), { columns: ['driver_id'], values: ['d118'] })
})

test('mapTruck sets active + mapped driver, and refuses maintenance or location mismatch', () => {
  // Kills: copying local status/driver_id; skipping the maintenance or location STOPs.
  const d = mapDriver(driverRow())
  const t = toRecord(mapTruck(truckRow({ status: 'idle' }), d))
  assert.equal(t.status, 'active')
  assert.equal(t.driver_id, 'd11')
  assert.ok(!('created_at' in t))
  assert.throws(() => mapTruck(truckRow({ status: 'maintenance' }), d), /maintenance/)
  assert.throws(() => mapTruck(truckRow({ location_city: 'Austin' }), d), /location/)
  assert.throws(() => mapTruck(truckRow({ location_state: 'OK' }), d), /location/)
  assert.throws(() => mapTruck(truckRow({ location_city: null }), d), /location/)
})

test('predictReadiness: stale MVR is expired, fresh MVR is valid', () => {
  // Kills: ignoring MVR age (a stale copy would pass); treating the default Ethan file as invalid.
  const driver = driverRow()
  const stale = predictReadiness({ driver, dq: dqRow() }, NOW)
  assert.equal(stale.statuses.mvr, 'expired')
  assert.equal(stale.ready, false)
  assert.equal(stale.dispatchClear, false)
  const fresh = predictReadiness({ driver, dq: dqRow({ mvr_checked_on: new Date(NOW) }) }, NOW)
  assert.equal(fresh.ready, true)
  assert.equal(fresh.dispatchClear, true)
  assert.equal(predictReadiness({ driver, dq: { driver_id: 'd118' } }, NOW).ready, true)
  const lapsed = predictReadiness({ driver: driverRow({ license_expires_on: new Date(NOW - DAY) }), dq: { driver_id: 'x' } }, NOW)
  assert.equal(lapsed.statuses.cdl, 'expired')
})

test('findCollisions reports each field and nothing on an empty prod', () => {
  // Kills: dropping any single collision check.
  const planned = { drivers: [{ id: 'd11', name: 'Grace Lindqvist', email: 'g@x.com', cdl_number: 'C1' }],
    trucks: [{ id: 'RS-9278-CY', vin: 'VIN' }], dqDriverIds: ['d11'] }
  assert.deepEqual(findCollisions({ drivers: [], trucks: [], dq: [] }, planned), [])
  const fields = (state) => findCollisions(state, planned).map((c) => c.field)
  const none = { id: 'dX', name: 'N', email: 'n@x.com', cdl_number: 'Z' }
  assert.deepEqual(fields({ drivers: [{ ...none, id: 'd11' }] }), ['driver id'])
  assert.deepEqual(fields({ drivers: [{ ...none, email: 'G@X.com' }] }), ['driver email'])
  assert.deepEqual(fields({ drivers: [{ ...none, cdl_number: 'C1' }] }), ['driver cdl_number'])
  assert.deepEqual(fields({ drivers: [{ ...none, name: ' grace lindqvist ' }] }), ['driver name'])
  assert.deepEqual(fields({ trucks: [{ id: 'RS-9278-CY', vin: 'o' }] }), ['truck id'])
  assert.deepEqual(fields({ trucks: [{ id: 'AA-0000-AA', vin: 'VIN' }] }), ['truck vin'])
  assert.deepEqual(fields({ dq: [{ driver_id: 'd11' }] }), ['dq driver_id'])
})

test('classifyColumns fails closed on unclassified and missing columns', () => {
  // Kills: letting a new live column or a vanished mapped column through.
  assert.equal(classifyColumns(liveColumns()), true)
  assert.throws(() => classifyColumns([...liveColumns(), { table_name: 'trucks', column_name: 'new_col' }]), /unclassified column trucks.new_col/)
  assert.throws(() => classifyColumns(liveColumns().filter((c) => c.column_name !== 'bio')), /missing column drivers.bio/)
  assert.throws(() => classifyColumns(liveColumns().filter((c) => c.table_name !== 'trucks')), /missing column trucks/)
})

test('compareSchemas flags version, column and unique differences', () => {
  // Kills: comparing only one aspect of the schemas.
  assert.equal(compareSchemas(schema(), schema()), true)
  assert.throws(() => compareSchemas(schema(), schema({ versions: ['001'] })), /migration 002/)
  assert.throws(() => compareSchemas(schema(), schema({ columns: liveColumns().map((c, i) => (i ? c : { ...c, data_type: 'integer' })) })), /column differs/)
  assert.throws(() => compareSchemas(schema(), schema({ uniques: [...EXPECTED_UNIQUES, 'trucks:vin'] })), /unique constraints/)
  assert.throws(() => compareSchemas(schema(), schema({ uniques: EXPECTED_UNIQUES.slice(1) })), /unique constraints/)
})

test('parseArgs accepts only --confirm / --dry-run, not both', () => {
  // Kills: silently ignoring a mistyped flag (a dry run turning into a write, or vice versa).
  assert.deepEqual(parseArgs([]), { confirm: false })
  assert.deepEqual(parseArgs(['--dry-run']), { confirm: false })
  assert.deepEqual(parseArgs(['--confirm']), { confirm: true })
  assert.throws(() => parseArgs(['--apply']), /Usage/)
  assert.throws(() => parseArgs(['--confirm', '--dry-run']), /Usage/)
})

test('checkHosts: local source, distinct target, hostnames only, no secrets', () => {
  // Kills: allowing a remote source or the same host, and echoing the connection string.
  const secret = 'S3cretPw'
  const ok = checkHosts({ sourceUrl: 'postgres://u:p@localhost:5432/db', targetUrl: `postgres://u:${secret}@db.prod.example.com/x` })
  assert.deepEqual(ok, { sourceHost: 'localhost', targetHost: 'db.prod.example.com' })
  assert.ok(!JSON.stringify(ok).includes(secret))
  assert.equal(checkHosts({ sourceUrl: 'postgres://u:p@127.0.0.1/db', targetUrl: 'postgres://u:p@h.example.com/x' }).sourceHost, '127.0.0.1')
  assert.throws(() => checkHosts({ sourceUrl: 'postgres://u:p@remote.example.com/db', targetUrl: 'postgres://u:p@h.example.com/x' }), /localhost/)
  assert.throws(() => checkHosts({ sourceUrl: 'postgres://u:p@localhost/db', targetUrl: 'postgres://u:p@localhost/db2' }), /same/)
  assert.throws(() => checkHosts({ sourceUrl: 'postgres://u:p@localhost/db', targetUrl: '' }), /missing/)
  assert.throws(() => checkHosts({ sourceUrl: 'postgres://localhost/db', targetUrl: `not a url ${secret}` }),
    (e) => !e.message.includes(secret))
})

// ---------- orchestrator ----------

function fakes({ prodDrivers = [], prodTrucks = [], prodDq = [], failTruckAt = 0, srcOverride = {}, prodSchema = schema(),
  localDq = dqRow({ mvr_checked_on: new Date(NOW - 500 * DAY) }) } = {}) {
  const calls = []
  let truckInserts = 0
  const common = (sql, s) => {
    if (sql.includes('schema_migrations')) return { rows: s.versions.map((version) => ({ version })) }
    if (sql.includes('information_schema.columns')) return { rows: s.columns }
    if (sql.includes('pg_index')) {
      return { rows: s.uniques.map((u) => { const [t, c] = u.split(':'); return { table_name: t, cols: c, pred: null } }) }
    }
    return null
  }
  const sourceCalls = []
  const source = {
    calls: sourceCalls,
    async query(sql) {
      sourceCalls.push(sql)
      const r = common(sql, schema())
      if (r) return r
      if (sql.includes('FROM drivers')) return { rows: srcOverride.drivers ?? [driverRow(), ethan()] }
      if (sql.includes('FROM driver_qualification')) return { rows: localDq ? [localDq] : [] }
      if (sql.includes('FROM trucks')) return { rows: srcOverride.trucks ?? [truckRow(), ethanTruck()] }
      return { rows: [] }
    },
  }
  const target = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('now() AS now')) return { rows: [{ now: new Date(NOW) }] }
      const r = common(sql, prodSchema)
      if (r) return r
      if (sql.includes('lower(btrim(name))')) return { rows: prodDrivers }
      if (sql.includes('FROM trucks WHERE id = ANY')) return { rows: prodTrucks }
      if (sql.includes('SELECT driver_id FROM driver_qualification')) return { rows: prodDq }
      if (sql.includes('"otherDrivers"')) return { rows: [{ otherDrivers: 5, withoutDq: 2 }] }
      if (sql.includes('last_value, is_called')) return { rows: [{ last_value: 117, is_called: true }] }
      if (sql.startsWith('INSERT INTO trucks') && failTruckAt && ++truckInserts === failTruckAt) throw new Error('truck insert failed')
      return { rows: [] }
    },
  }
  return { source, target, calls }
}
const writes = (calls) => calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) || /setval|advisory/.test(sql))
const verifyOk = async () => ({ mode: 'fake' })

test('dry run opens READ ONLY and issues no write, lock or setval', async () => {
  // Kills: dry run beginning a writable tx, or touching the sequence/lock.
  const { source, target, calls } = fakes()
  const res = await runCopy({ source, target, confirm: false, nowMs: NOW, verify: verifyOk })
  assert.equal(res.mode, 'dry-run')
  assert.equal(calls[0].sql, 'BEGIN READ ONLY')
  assert.equal(calls.at(-1).sql, 'COMMIT')
  assert.deepEqual(writes(calls), [])
  assert.equal(res.planned.dq[0].mvr_checked_on, new Date(NOW).toISOString())
  assert.equal(res.prod.otherDrivers, 5)
})

test('collision rolls back with zero INSERTs', async () => {
  // Kills: inserting before or despite a collision.
  const { source, target, calls } = fakes({ prodDrivers: [{ id: 'd5', name: 'Grace Lindqvist', email: 'z@z.com', cdl_number: 'Q' }] })
  await assert.rejects(runCopy({ source, target, confirm: true, nowMs: NOW, verify: verifyOk }), /Blocked/)
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
  assert.equal(calls.filter(({ sql }) => sql.startsWith('INSERT')).length, 0)
  assert.ok(!calls.some(({ sql }) => /setval/.test(sql)))
})

test('second truck insert failing rolls back and never bumps the sequence', async () => {
  // Kills: setval before the inserts finish, or committing a partial copy.
  const { source, target, calls } = fakes({ failTruckAt: 2 })
  await assert.rejects(runCopy({ source, target, confirm: true, nowMs: NOW, verify: verifyOk }), /truck insert failed/)
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!calls.some(({ sql }) => /setval/.test(sql) || sql === 'COMMIT'))
})

test('apply: lock first, only INSERTs, setval is the last write before COMMIT', async () => {
  // Kills: UPDATE/DELETE on existing rows, a missing advisory lock, setval in the wrong place.
  const { source, target, calls } = fakes()
  const res = await runCopy({ source, target, confirm: true, nowMs: NOW, verify: verifyOk })
  assert.equal(res.applied, true)
  assert.equal(calls[0].sql, 'BEGIN')
  assert.equal(calls[1].sql, LOCK_SQL)
  assert.ok(!calls.some(({ sql }) => /^\s*(UPDATE|DELETE)/i.test(sql)))
  assert.ok(!calls.some(({ sql }) => /ON CONFLICT/i.test(sql)))
  const inserts = calls.filter(({ sql }) => sql.startsWith('INSERT'))
  assert.deepEqual(inserts.map(({ sql }) => sql.split(' ')[2]),
    ['drivers', 'drivers', 'driver_qualification', 'driver_qualification', 'trucks', 'trucks'])
  assert.deepEqual(inserts[3].params, ['d118'])
  assert.equal(calls.at(-2).sql, SETVAL_SQL)
  assert.equal(calls.at(-1).sql, 'COMMIT')
  const lastInsert = calls.map(({ sql }) => sql).lastIndexOf(inserts.at(-1).sql)
  assert.ok(calls.findIndex(({ sql }) => sql === SETVAL_SQL) > lastInsert)
})

test('apply is blocked when readiness fails', async () => {
  // Kills: the readiness STOP (an expired medical card must not be copied into a dispatchable driver).
  const bad = fakes({ localDq: dqRow({ medical_status: 'expired' }) })
  await assert.rejects(runCopy({ source: bad.source, target: bad.target, confirm: true, nowMs: NOW, verify: verifyOk }), /not ready/)
  assert.equal(bad.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(bad.calls.filter(({ sql }) => sql.startsWith('INSERT')).length, 0)
})

test('verification failure rolls back before setval', async () => {
  // Kills: committing when the in-transaction dispatch check fails.
  const { source, target, calls } = fakes()
  await assert.rejects(runCopy({ source, target, confirm: true, nowMs: NOW,
    verify: async () => { throw new Error('not dispatch-clear') } }), /dispatch-clear/)
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
  assert.ok(!calls.some(({ sql }) => /setval/.test(sql)))
})

test('source mismatch (wrong name) stops before any prod statement', async () => {
  // Kills: copying an id that now belongs to somebody else.
  const { source, target, calls } = fakes({ srcOverride: { drivers: [driverRow({ name: 'Someone Else' }), ethan()] } })
  await assert.rejects(runCopy({ source, target, confirm: true, nowMs: NOW, verify: verifyOk }), /not Grace Lindqvist/)
  assert.equal(calls.length, 0)
  assert.equal(PLAN.length, 2)
})

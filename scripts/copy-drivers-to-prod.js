// One-off, owner-approved copy of two drivers and their trucks from the LOCAL
// database (DATABASE_URL) to PROD (DATABASE_URL_PROD):
//   Grace Lindqvist d11 + RS-9278-CY,  Ethan Brooks d118 + IL-2048-EB.
// They arrive as freshly hired, dispatchable drivers: identity, persona and
// equipment are copied; duty clock, mileage and ratings are reset; nothing
// else (loads, ledgers, chats, logs) travels.
//
// Safety shape:
//   * default is a dry run (BEGIN READ ONLY on prod); writes need --confirm
//   * one transaction, plain INSERTs -- no ON CONFLICT, no UPDATE, no DELETE
//     on drivers/trucks/driver_qualification, so no existing prod row can change
//   * any collision, schema difference or readiness failure => ROLLBACK
//   * columns are classified against information_schema on both databases;
//     a column nobody classified stops the run instead of being guessed at
//   * only hostnames are ever printed -- never URLs, passwords or env values
import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  MVR_MAX_AGE_DAYS, MVR_EXPIRING_DAYS, readDocumentStatus, dispatchClear,
} from '../src/constants/driverQualification.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

export const USAGE = 'Usage: node scripts/copy-drivers-to-prod.js [--dry-run | --confirm]'
export const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('copy-drivers-to-prod'))"
export const SETVAL_SQL = `SELECT setval('hired_driver_id_seq', GREATEST(118, CASE WHEN is_called THEN last_value ELSE last_value - 1 END), true) FROM hired_driver_id_seq`

// Owner-approved pairs. Names are asserted against the source so a reused id
// or plate can never copy somebody else.
export const PLAN = Object.freeze([
  { driverId: 'd11', name: 'Grace Lindqvist', truckId: 'RS-9278-CY', hasLocalDq: true },
  { driverId: 'd118', name: 'Ethan Brooks', truckId: 'IL-2048-EB', hasLocalDq: false },
])

// Duty status of a freshly hired driver. provision-ethan.js and the plan use
// 'on-duty'; hr.service.js hires into 'resting'. Never 'off' (the DQ list and
// dispatch filter hide off-duty drivers).
export const HIRED_DUTY_STATUS = 'on-duty'

// Every live column of the three tables must be listed here exactly once.
export const MAPPING = Object.freeze({
  drivers: {
    copy: ['id', 'name', 'email', 'phone', 'cdl_class', 'cdl_number', 'license_expires_on',
      'home_base_city', 'home_base_state', 'current_location', 'current_city', 'current_state',
      'current_lat', 'current_lon', 'pay_model', 'pay_percent_bp', 'pay_per_mile_cents',
      'bio', 'preferences'],
    reset: ['duty_status', 'hos_remaining_min', 'hours_today_min', 'hours_week_min',
      'total_miles', 'safety_rating', 'broker_rating_x10'],
    omit: ['created_at', 'updated_at'],
  },
  driver_qualification: {
    copy: ['driver_id', 'cdl_status', 'medical_expires_on', 'medical_status', 'mvr_violations',
      'mvr_status', 'da_status'],
    reset: ['mvr_checked_on'],
    omit: ['updated_at'],
  },
  trucks: {
    copy: ['id', 'make', 'model', 'year', 'odometer_mi', 'fuel_pct', 'fuel_gallons',
      'fuel_capacity_gal', 'tire_front_pct', 'tire_rear_pct', 'trailer_type', 'trailer_length_ft',
      'vin', 'engine_make', 'engine_model', 'horsepower', 'transmission', 'sleeper', 'suspension',
      'axle_config', 'wheelbase_in', 'front_axle_lbs', 'rear_axle_lbs', 'gvwr_lbs', 'has_apu',
      'last_fueled_at', 'last_fueled_location', 'current_location', 'location_city', 'location_state'],
    reset: ['status', 'driver_id'],
    omit: ['created_at', 'updated_at'],
  },
})
const TABLES = Object.keys(MAPPING)
const JSON_COLUMNS = new Set(['preferences'])

// Unique indexes expected on prod, as "table:col,col" (no predicate).
export const EXPECTED_UNIQUES = Object.freeze([
  'driver_qualification:driver_id',
  'drivers:cdl_number', 'drivers:email', 'drivers:id',
  'trucks:driver_id', 'trucks:id',
])

// Migration 039 column defaults for a DQ row inserted with driver_id only.
const DQ_DEFAULTS = Object.freeze({
  cdl_status: 'valid', medical_expires_on: null, medical_status: 'valid',
  mvr_checked_on: null, mvr_violations: 0, mvr_status: 'valid', da_status: 'valid',
})

const COLUMNS_SQL = `SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = ANY($1)
 ORDER BY table_name, column_name`
const VERSIONS_SQL = 'SELECT version FROM schema_migrations ORDER BY version'
const UNIQUES_SQL = `SELECT c.relname AS table_name,
       (SELECT string_agg(coalesce(a.attname, '<expr>'), ',' ORDER BY k.ord)
          FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
          LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS cols,
       pg_get_expr(i.indpred, i.indrelid) AS pred
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = ANY($1) AND i.indisunique`

// ---------- 1. args and hosts ----------

export function parseArgs(argv) {
  const bad = argv.filter((a) => !['--confirm', '--dry-run'].includes(a))
  if (bad.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    throw new Error(USAGE)
  }
  return { confirm: argv.includes('--confirm') }
}

function hostnameOf(url, label) {
  if (typeof url !== 'string' || url.trim() === '') throw new Error(`${label} connection string is missing`)
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    // Never echo the string: it may hold a password.
    throw new Error(`${label} connection string could not be parsed`)
  }
}

export function isLocalHost(hostname) {
  return /^(localhost|127\.0\.0\.1)$/.test(hostname)
}

export function checkHosts({ sourceUrl, targetUrl }) {
  const sourceHost = hostnameOf(sourceUrl, 'Source')
  const targetHost = hostnameOf(targetUrl, 'Target')
  if (!isLocalHost(sourceHost)) throw new Error('Source host must be localhost or 127.0.0.1')
  if (targetHost === '') throw new Error('Target host is empty')
  if (targetHost === sourceHost) throw new Error('Source and target hosts are the same; refusing')
  return { sourceHost, targetHost }
}

// Same rule as src/db/pool.js: local = plain TCP, anything else = TLS with
// verification unless PG_SSL_NO_VERIFY=1.
export function sslFor(hostname, env = process.env) {
  return isLocalHost(hostname) ? false : { rejectUnauthorized: env.PG_SSL_NO_VERIFY !== '1' }
}

// ---------- 2. column classification and schema comparison ----------

// liveColumns: [{ table_name, column_name }]. Fails closed on any live column
// absent from MAPPING and any mapped column absent from the live table.
export function classifyColumns(liveColumns, mapping = MAPPING) {
  const problems = []
  for (const [table, spec] of Object.entries(mapping)) {
    const known = new Set([...spec.copy, ...spec.reset, ...spec.omit])
    const live = new Set(liveColumns.filter((c) => c.table_name === table).map((c) => c.column_name))
    for (const col of live) if (!known.has(col)) problems.push(`unclassified column ${table}.${col}`)
    for (const col of known) if (!live.has(col)) problems.push(`missing column ${table}.${col}`)
  }
  if (problems.length) throw new Error(`Column classification failed: ${problems.join('; ')}`)
  return true
}

export async function readSchema(client) {
  const versions = (await client.query(VERSIONS_SQL)).rows.map((r) => r.version)
  const columns = (await client.query(COLUMNS_SQL, [TABLES])).rows
  const uniques = (await client.query(UNIQUES_SQL, [TABLES])).rows
    .map((r) => `${r.table_name}:${r.cols}${r.pred ? `|${r.pred}` : ''}`).sort()
  return { versions, columns, uniques }
}

const colKey = (c) => `${c.table_name}.${c.column_name}:${c.data_type}:${c.is_nullable}`

export function compareSchemas(local, prod) {
  const problems = []
  const lv = new Set(local.versions)
  const pv = new Set(prod.versions)
  for (const v of lv) if (!pv.has(v)) problems.push(`migration ${v} applied locally but not on prod`)
  for (const v of pv) if (!lv.has(v)) problems.push(`migration ${v} applied on prod but not locally`)
  const lc = new Set(local.columns.map(colKey))
  const pc = new Set(prod.columns.map(colKey))
  for (const c of lc) if (!pc.has(c)) problems.push(`column differs (local only): ${c}`)
  for (const c of pc) if (!lc.has(c)) problems.push(`column differs (prod only): ${c}`)
  const got = [...prod.uniques].sort()
  const want = [...EXPECTED_UNIQUES].sort()
  if (got.join('\n') !== want.join('\n')) {
    problems.push(`unique constraints on prod are [${got.join(', ')}], expected [${want.join(', ')}]`)
  }
  if (problems.length) throw new Error(`Schema mismatch: ${problems.join('; ')}`)
  return true
}

// ---------- 3. row mapping ----------

export const toRecord = ({ columns, values }) => Object.fromEntries(columns.map((c, i) => [c, values[i]]))

function pickCopy(table, row) {
  for (const col of MAPPING[table].copy) {
    if (!(col in row)) throw new Error(`Source ${table} row is missing column ${col}`)
  }
  return MAPPING[table].copy.map((c) => [c, row[c]])
}

export function mapDriver(row) {
  if (row.current_lat == null || row.current_lon == null) {
    throw new Error(`Driver ${row.id} has no coordinates; refusing (dispatch skips drivers without them)`)
  }
  const entries = [
    ...pickCopy('drivers', row),
    ['duty_status', HIRED_DUTY_STATUS], ['hos_remaining_min', 660], ['hours_today_min', 0],
    ['hours_week_min', 0], ['total_miles', 0], ['safety_rating', 100], ['broker_rating_x10', 50],
  ]
  return { columns: entries.map(([c]) => c), values: entries.map(([, v]) => v) }
}

// Grace: her local file, MVR re-dated to prod "now" (pre-employment pull).
// Ethan (no local row): driver_id only, so the table defaults apply.
export function mapDq(localDq, driverId, prodNowIso) {
  if (!localDq) return { columns: ['driver_id'], values: [driverId] }
  const entries = [
    ...pickCopy('driver_qualification', { ...localDq, driver_id: driverId }),
    ['mvr_checked_on', prodNowIso],
  ]
  return { columns: entries.map(([c]) => c), values: entries.map(([, v]) => v) }
}

export function mapTruck(localTruck, mappedDriver) {
  const driver = toRecord(mappedDriver)
  if (localTruck.status === 'maintenance') throw new Error(`Truck ${localTruck.id} is in maintenance; refusing`)
  if (localTruck.location_city !== driver.current_city || localTruck.location_state !== driver.current_state) {
    throw new Error(`Truck ${localTruck.id} location does not match driver ${driver.id} current city/state; refusing`)
  }
  const entries = [...pickCopy('trucks', localTruck), ['status', 'active'], ['driver_id', driver.id]]
  return { columns: entries.map(([c]) => c), values: entries.map(([, v]) => v) }
}

// ---------- 4. readiness and collisions ----------

// Reads the DQ file the way compliance.service.listDriverQualification does
// (same helpers, same MVR-age formula) so the prediction cannot drift.
export function predictReadiness({ driver, dq }, nowMs) {
  const file = { ...DQ_DEFAULTS, ...(dq ?? {}) }
  const cdl = readDocumentStatus(file.cdl_status, driver.license_expires_on, nowMs)
  const medical = readDocumentStatus(file.medical_status, file.medical_expires_on, nowMs)
  let mvr = file.mvr_status
  if (file.mvr_checked_on != null) {
    const ageDays = Math.ceil((nowMs - new Date(file.mvr_checked_on).getTime()) / REAL_MS_PER_SIM_DAY)
    mvr = ageDays > MVR_MAX_AGE_DAYS ? 'expired'
      : (ageDays > MVR_MAX_AGE_DAYS - MVR_EXPIRING_DAYS ? 'expiring' : 'valid')
  }
  const statuses = { cdl, medical, mvr, drugAlcohol: file.da_status }
  const notValid = Object.entries(statuses).filter(([, s]) => s !== 'valid').map(([k, s]) => `${k}=${s}`)
  return { statuses, dispatchClear: dispatchClear(Object.values(statuses)), ready: notValid.length === 0, notValid }
}

// prodState: rows already filtered to possible matches. planned: what we insert.
export function findCollisions(prodState, planned) {
  const found = []
  const norm = (s) => String(s ?? '').trim().toLowerCase()
  for (const p of planned.drivers) {
    for (const d of prodState.drivers ?? []) {
      if (d.id === p.id) found.push({ field: 'driver id', value: p.id })
      if (norm(d.email) === norm(p.email)) found.push({ field: 'driver email', value: p.id })
      if (d.cdl_number === p.cdl_number) found.push({ field: 'driver cdl_number', value: p.id })
      if (norm(d.name) === norm(p.name)) found.push({ field: 'driver name', value: p.name })
    }
  }
  for (const p of planned.trucks) {
    for (const t of prodState.trucks ?? []) {
      if (t.id === p.id) found.push({ field: 'truck id', value: p.id })
      if (p.vin != null && t.vin === p.vin) found.push({ field: 'truck vin', value: p.id })
    }
  }
  for (const id of planned.dqDriverIds) {
    if ((prodState.dq ?? []).some((q) => q.driver_id === id)) found.push({ field: 'dq driver_id', value: id })
  }
  return found
}

// ---------- 5. database steps ----------

export async function readSource(client) {
  await client.query('BEGIN READ ONLY')
  try {
    const ids = PLAN.map((p) => p.driverId)
    const truckIds = PLAN.map((p) => p.truckId)
    const schema = await readSchema(client)
    classifyColumns(schema.columns)
    const drivers = (await client.query('SELECT * FROM drivers WHERE id = ANY($1)', [ids])).rows
    const dq = (await client.query('SELECT * FROM driver_qualification WHERE driver_id = ANY($1)', [ids])).rows
    const trucks = (await client.query('SELECT * FROM trucks WHERE id = ANY($1)', [truckIds])).rows
    for (const p of PLAN) {
      const d = drivers.find((r) => r.id === p.driverId)
      const t = trucks.find((r) => r.id === p.truckId)
      if (!d || d.name !== p.name) throw new Error(`Source driver ${p.driverId} is not ${p.name}`)
      if (!t || t.driver_id !== p.driverId) throw new Error(`Source truck ${p.truckId} is not assigned to ${p.driverId}`)
    }
    await client.query('COMMIT')
    return { schema, drivers, dq, trucks }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function readProdState(client, planned) {
  const emails = planned.drivers.map((d) => d.email.toLowerCase())
  const names = planned.drivers.map((d) => d.name.trim().toLowerCase())
  const vins = planned.trucks.map((t) => t.vin).filter((v) => v != null)
  return {
    drivers: (await client.query(
      `SELECT id, name, email, cdl_number FROM drivers
        WHERE id = ANY($1) OR lower(email) = ANY($2) OR cdl_number = ANY($3) OR lower(btrim(name)) = ANY($4)`,
      [planned.drivers.map((d) => d.id), emails, planned.drivers.map((d) => d.cdl_number), names])).rows,
    trucks: (await client.query(
      'SELECT id, vin, driver_id FROM trucks WHERE id = ANY($1) OR vin = ANY($2)',
      [planned.trucks.map((t) => t.id), vins])).rows,
    dq: (await client.query('SELECT driver_id FROM driver_qualification WHERE driver_id = ANY($1)',
      [planned.dqDriverIds])).rows,
  }
}

function insertStatement(table, { columns, values }) {
  const slots = columns.map((c, i) => (JSON_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`))
  const params = values.map((v, i) => (JSON_COLUMNS.has(columns[i]) && v != null ? JSON.stringify(v) : v))
  return [`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${slots.join(', ')})`, params]
}

// In-transaction proof on the target client, using the app's own readers.
// If they cannot be imported (config demands env this script lacks) we say so
// and rely on predictReadiness instead.
export async function defaultVerify(client, driverIds) {
  let compliance
  let availability
  try {
    compliance = await import('../src/modules/compliance/compliance.service.js')
    availability = await import('../src/modules/availability/availability.service.js')
  } catch {
    return { mode: 'predict-only', note: 'app services could not be imported; relied on predictReadiness' }
  }
  const list = await compliance.listDriverQualification({ client })
  for (const id of driverIds) {
    const entry = list.drivers.find((d) => d.driver.id === id)
    if (!entry || !entry.dispatchClear) throw new Error(`Verification failed: ${id} is not dispatch-clear`)
    const avail = await availability.driverAvailability(client, id)
    if (!avail.available) throw new Error(`Verification failed: ${id} is not available`)
  }
  return { mode: 'app-services' }
}

export async function runCopy({ source, target, confirm = false, verify = defaultVerify, nowMs = Date.now() }) {
  const src = await readSource(source)

  await target.query(confirm ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    if (confirm) await target.query(LOCK_SQL)
    const prodNowIso = new Date((await target.query('SELECT now() AS now')).rows[0].now).toISOString()

    const prodSchema = await readSchema(target)
    classifyColumns(prodSchema.columns)
    compareSchemas(src.schema, prodSchema)

    const rows = { drivers: [], dq: [], trucks: [] }
    const readiness = []
    for (const p of PLAN) {
      const localDriver = src.drivers.find((r) => r.id === p.driverId)
      const driver = mapDriver(localDriver)
      const localDq = p.hasLocalDq ? (src.dq.find((r) => r.driver_id === p.driverId) ?? null) : null
      const dq = mapDq(localDq, p.driverId, prodNowIso)
      const truck = mapTruck(src.trucks.find((r) => r.id === p.truckId), driver)
      rows.drivers.push(driver)
      rows.dq.push(dq)
      rows.trucks.push(truck)
      readiness.push({
        driverId: p.driverId,
        ...predictReadiness({ driver: toRecord(driver), dq: toRecord(dq) }, nowMs),
      })
    }

    const planned = {
      drivers: rows.drivers.map(toRecord),
      trucks: rows.trucks.map(toRecord),
      dqDriverIds: PLAN.map((p) => p.driverId),
    }
    const collisions = findCollisions(await readProdState(target, planned), planned)
    const stats = (await target.query(
      `SELECT count(*)::int AS "otherDrivers",
              (count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM driver_qualification q WHERE q.driver_id = d.id)))::int AS "withoutDq"
         FROM drivers d`)).rows[0]
    const seq = (await target.query('SELECT last_value, is_called FROM hired_driver_id_seq')).rows[0]

    const blockers = [
      ...collisions.map((c) => `collision: ${c.field} (${c.value})`),
      ...readiness.filter((r) => !r.ready).map((r) => `not ready: ${r.driverId} ${r.notValid.join(', ')}`),
    ]
    const preview = {
      mode: confirm ? 'apply' : 'dry-run',
      prodNow: prodNowIso,
      planned: { drivers: planned.drivers, dq: rows.dq.map(toRecord), trucks: planned.trucks },
      collisions, readiness, blockers,
      prod: { otherDrivers: stats.otherDrivers, driversWithoutDq: stats.withoutDq, hiredDriverIdSeq: seq },
    }

    if (!confirm) {
      await target.query('COMMIT')
      return preview
    }
    if (blockers.length) throw new Error(`Blocked, nothing written: ${blockers.join('; ')}`)

    for (const [table, list] of [['drivers', rows.drivers], ['driver_qualification', rows.dq], ['trucks', rows.trucks]]) {
      for (const row of list) {
        const [sql, params] = insertStatement(table, row)
        await target.query(sql, params)
      }
    }
    const verification = await verify(target, PLAN.map((p) => p.driverId))
    // Last write: future HR hires must skip d118. (setval is not transactional
    // in Postgres, which is harmless: the bump is monotonic.)
    await target.query(SETVAL_SQL)
    await target.query('COMMIT')
    return { ...preview, applied: true, verification }
  } catch (err) {
    await target.query('ROLLBACK')
    throw err
  }
}

// ---------- 6. entry point ----------

async function main() {
  const { confirm } = parseArgs(process.argv.slice(2))
  const sourceUrl = process.env.DATABASE_URL
  const targetUrl = process.env.DATABASE_URL_PROD
  const { sourceHost, targetHost } = checkHosts({ sourceUrl, targetUrl })
  console.log(`source host: ${sourceHost}`)
  console.log(`target host: ${targetHost}`)
  console.log(confirm ? 'mode: APPLY (--confirm)' : 'mode: dry run (read-only)')

  const source = new pg.Client({ connectionString: sourceUrl, ssl: sslFor(sourceHost) })
  const target = new pg.Client({ connectionString: targetUrl, ssl: sslFor(targetHost) })
  try {
    await source.connect()
    await target.connect()
    const result = await runCopy({ source, target, confirm })
    console.log(JSON.stringify(result, null, 2))
    if (result.blockers.length) process.exitCode = 2
  } finally {
    await source.end().catch(() => {})
    await target.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1 })
}

// Adds the company's leased trucks: 8 new, unassigned, so the whole fleet is
// 6 dry-van (53'), 2 reefer (53') and 2 flatbed (48'/53'), counting what is
// already there. Not a seed and not a purchase: no ledger entry. Rent only
// starts when a dispatcher assigns a driver (migration 075).
//
// Default is a dry run. --confirm writes, in one transaction, and writes
// nothing at all if any plate already exists.
//   node scripts/provision-trucks.js               # preview
//   node scripts/provision-trucks.js --confirm     # write
//   npm run prod -- provision:trucks --confirm      # production (prod.js adds --allow-remote)
import { pathToFileURL } from 'node:url'

// Keyed by equipmentType key (data/equipmentTypes.js).
export const TARGET_FLEET_MIX = Object.freeze({ 'dry-van': 6, reefer: 2, flatbed: 2 })
export const NEW_TRUCK_COUNT = 8
export const PLATE_FORMAT = /^[A-Z]{2}-[0-9]{4}-[A-Z]{2}$/

const FULL_TANK_GAL = 240
const NEW_TRUCK_WEAR_PCT = 100
const NEW_TRUCK_ODOMETER_MI = 42000
const STANDARD_TRAILER_FT = 53
const FLATBED_SHORT_TRAILER_FT = 48
const LOCK_KEY = 'provision-trucks'

const truck = (id, make, model, year, city, state, trailerLengthFt = STANDARD_TRAILER_FT) =>
  Object.freeze({ id, make, model, year, city, state, trailerLengthFt })

// Enough candidates per type for the whole target mix; the first `need` are used.
export const CANDIDATES = Object.freeze({
  'dry-van': Object.freeze([
    truck('TX-5101-DV', 'Freightliner', 'Cascadia', 2022, 'Dallas', 'TX'),
    truck('GA-5102-DV', 'Volvo', 'VNL 860', 2022, 'Atlanta', 'GA'),
    truck('IL-5103-DV', 'Kenworth', 'T680', 2023, 'Chicago', 'IL'),
    truck('TN-5104-DV', 'Peterbilt', '579', 2021, 'Memphis', 'TN'),
    truck('OH-5105-DV', 'International', 'LT', 2022, 'Columbus', 'OH'),
    truck('MO-5106-DV', 'Freightliner', 'Cascadia', 2023, 'Kansas City', 'MO'),
  ]),
  reefer: Object.freeze([
    truck('CA-5201-RF', 'Volvo', 'VNL 760', 2022, 'Fresno', 'CA'),
    truck('AZ-5202-RF', 'Kenworth', 'T680', 2023, 'Phoenix', 'AZ'),
  ]),
  flatbed: Object.freeze([
    truck('TX-5301-FB', 'Peterbilt', '567', 2021, 'Houston', 'TX', FLATBED_SHORT_TRAILER_FT),
    truck('AL-5302-FB', 'Freightliner', '122SD', 2022, 'Birmingham', 'AL'),
  ]),
})

export async function provisionTrucks(client, { confirm = false } = {}) {
  await client.query(confirm ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    if (confirm) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY])
    const existing = await client.query('SELECT trailer_type AS "equipmentType", count(*)::int AS count FROM trucks GROUP BY trailer_type')
    const have = {}
    for (const row of existing.rows) have[row.equipmentType] = row.count
    if (Object.keys(have).some((type) => !(type in TARGET_FLEET_MIX))) throw new Error('Fleet mix differs; nothing changed.')
    const need = Object.fromEntries(Object.entries(TARGET_FLEET_MIX).map(([type, target]) => [type, target - (have[type] ?? 0)]))
    const needed = Object.values(need)
    if (needed.every((n) => n === 0)) {
      await client.query('COMMIT')
      return { action: 'already-complete', have }
    }
    if (needed.some((n) => n < 0) || needed.reduce((sum, n) => sum + n, 0) !== NEW_TRUCK_COUNT) throw new Error('Fleet mix differs; nothing changed.')

    const planned = Object.entries(need).flatMap(([type, n]) => CANDIDATES[type].slice(0, n).map((t) => ({ ...t, equipmentType: type })))
    const taken = await client.query('SELECT id FROM trucks WHERE id = ANY($1::text[])', [planned.map((t) => t.id)])
    if (taken.rows.length > 0) throw new Error(`Truck plate already exists (${taken.rows.map((r) => r.id).join(', ')}); nothing changed.`)

    if (!confirm) {
      await client.query('COMMIT')
      return { action: 'preview', have, need, trucks: planned }
    }
    for (const t of planned) {
      await client.query(
        `INSERT INTO trucks (id, make, model, year, odometer_mi, status, driver_id,
           current_location, location_city, location_state, trailer_type, trailer_length_ft,
           fuel_pct, fuel_gallons, fuel_capacity_gal, tire_front_pct, tire_rear_pct,
           transmission, sleeper, suspension, axle_config, front_axle_lbs, rear_axle_lbs, gvwr_lbs, has_apu,
           is_leased)
         VALUES ($1, $2, $3, $4, $5, 'idle', NULL, $6, $7, $8, $9, $10, 100, $11, $11, $12, $12,
           'automated-12', 'sleeper-72', 'air-ride', '6x4', 12000, 40000, 52000, true, true)`,
        [t.id, t.make, t.model, t.year, NEW_TRUCK_ODOMETER_MI, `${t.city}, ${t.state}`, t.city, t.state,
          t.equipmentType, t.trailerLengthFt, FULL_TANK_GAL, NEW_TRUCK_WEAR_PCT],
      )
    }
    await client.query('COMMIT')
    return { action: 'created', have, need, trucks: planned }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

const KNOWN_ARGS = ['--confirm', '--dry-run', '--allow-remote']

export function parseArgs(args) {
  if (args.some((arg) => !KNOWN_ARGS.includes(arg)) || (args.includes('--confirm') && args.includes('--dry-run'))) {
    throw new Error('Usage: node scripts/provision-trucks.js [--dry-run | --confirm] [--allow-remote]')
  }
  return { confirm: args.includes('--confirm'), allowRemote: args.includes('--allow-remote') }
}

export function isLocalHost(databaseUrl) {
  const host = new URL(databaseUrl).hostname
  return host === 'localhost' || host === '127.0.0.1'
}

async function main() {
  const { confirm, allowRemote } = parseArgs(process.argv.slice(2))
  await import('dotenv/config')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  if (!isLocalHost(process.env.DATABASE_URL) && !allowRemote) {
    throw new Error(`refuses to touch ${new URL(process.env.DATABASE_URL).hostname} without --allow-remote`)
  }
  const { pool } = await import('../src/db/pool.js')
  const client = await pool.connect()
  try {
    console.log(JSON.stringify(await provisionTrucks(client, { confirm }), null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1 })
}

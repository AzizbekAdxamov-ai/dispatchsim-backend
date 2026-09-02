#!/usr/bin/env node
// clear-fleet.js — surgical fleet cleanup.
//
// Removes seed-generated drivers, trucks, loads, maintenance records,
// and daily metrics while preserving:
//   - HR-hired drivers (identified via driver_applicants.hired_driver_id)
//   - Board-booked loads (identified via load_postings.booked_load_id)
//   - All load_postings, driver_applicants, users, invite_codes, roles
//
// Usage:
//   node scripts/clear-fleet.js              # dry run (default)
//   node scripts/clear-fleet.js --confirm    # actually delete

import 'dotenv/config'
import { Pool } from 'pg'

// ── 1. Host guard ────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const host = new URL(DB_URL).hostname
if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
  console.error(`refuses to delete from ${host} without --allow-remote`)
  process.exit(1)
}

const CONFIRM = process.argv.includes('--confirm')

// ── 2. Helpers ───────────────────────────────────────────────────────────

async function count(pool, table, where = '') {
  const sql = `SELECT count(*)::int AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`
  const { rows } = await pool.query(sql)
  return rows[0].n
}

async function collectInfo(pool) {
  const [
    driversTotal, driversHired,
    loadsTotal, loadsBooked,
    trucksTotal, metricsTotal, maintenanceTotal,
    postingsTotal, applicantsTotal,
  ] = await Promise.all([
    count(pool, 'drivers'),
    count(pool, 'drivers', `id IN (SELECT hired_driver_id FROM driver_applicants WHERE hired_driver_id IS NOT NULL)`),
    count(pool, 'loads'),
    count(pool, 'loads', `id IN (SELECT booked_load_id FROM load_postings WHERE booked_load_id IS NOT NULL)`),
    count(pool, 'trucks'),
    count(pool, 'truck_daily_metrics'),
    count(pool, 'maintenance_records'),
    count(pool, 'load_postings'),
    count(pool, 'driver_applicants'),
  ])

  return {
    drivers: { total: driversTotal, hired: driversHired, seed: driversTotal - driversHired },
    loads: { total: loadsTotal, booked: loadsBooked, seed: loadsTotal - loadsBooked },
    trucks: { total: trucksTotal },
    metrics: { total: metricsTotal },
    maintenance: { total: maintenanceTotal },
    postings: { total: postingsTotal },
    applicants: { total: applicantsTotal },
  }
}

// ── 3. Main ──────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DB_URL })

  try {
    const before = await collectInfo(pool)

    console.log('\n── Current counts ──')
    console.log(`  drivers:        ${before.drivers.total} (${before.drivers.hired} hired, ${before.drivers.seed} seed)`)
    console.log(`  loads:          ${before.loads.total} (${before.loads.booked} booked, ${before.loads.seed} seed)`)
    console.log(`  trucks:         ${before.trucks.total}`)
    console.log(`  daily metrics:  ${before.metrics.total}`)
    console.log(`  maintenance:    ${before.maintenance.total}`)
    console.log(`  load_postings:  ${before.postings.total} (preserved)`)
    console.log(`  applicants:     ${before.applicants.total} (preserved)`)

    if (!CONFIRM) {
      console.log('\n── Dry run ──')
      console.log(`  Would delete: ${before.drivers.seed} drivers, ${before.loads.seed} loads,`)
      console.log(`                ${before.trucks.total} trucks, ${before.metrics.total} metrics,`)
      console.log(`                ${before.maintenance.total} maintenance records`)
      console.log('  Run with --confirm to execute.\n')
      return
    }

    console.log('\n── Deleting ──')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1) Seed loads (skip booked ones)
      const { rowCount: loadsDeleted } = await client.query(
        `DELETE FROM loads
          WHERE id NOT IN (
            SELECT booked_load_id FROM load_postings WHERE booked_load_id IS NOT NULL
          )`,
      )
      console.log(`  loads:          ${loadsDeleted} deleted`)

      // 2) Metrics and maintenance
      const { rowCount: metricsDeleted } = await client.query('DELETE FROM truck_daily_metrics')
      console.log(`  daily metrics:  ${metricsDeleted} deleted`)

      const { rowCount: maintDeleted } = await client.query('DELETE FROM maintenance_records')
      console.log(`  maintenance:    ${maintDeleted} deleted`)

      // 3) Trucks (fleet-manager hasn't added any yet)
      const { rowCount: trucksDeleted } = await client.query('DELETE FROM trucks')
      console.log(`  trucks:         ${trucksDeleted} deleted`)

      // 4) Seed drivers (keep HR-hired ones)
      const { rowCount: driversDeleted } = await client.query(
        `DELETE FROM drivers
          WHERE id NOT IN (
            SELECT hired_driver_id FROM driver_applicants WHERE hired_driver_id IS NOT NULL
          )`,
      )
      console.log(`  drivers:        ${driversDeleted} deleted`)

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    const after = await collectInfo(pool)

    console.log('\n── After cleanup ──')
    console.log(`  drivers:        ${after.drivers.total} (all hired)`)
    console.log(`  loads:          ${after.loads.total} (all booked)`)
    console.log(`  trucks:         ${after.trucks.total}`)
    console.log(`  daily metrics:  ${after.metrics.total}`)
    console.log(`  maintenance:    ${after.maintenance.total}`)
    console.log(`  load_postings:  ${after.postings.total} (untouched)`)
    console.log(`  applicants:     ${after.applicants.total} (untouched)`)
    console.log('')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})

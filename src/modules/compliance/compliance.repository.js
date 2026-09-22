// Data access for /compliance. Read-only: this module never writes
// duty_events (hos/dutyEvents.repository.js owns that table's writes).

import { pool } from '../../db/pool.js'
import * as SQL from './compliance.sql.js'

export async function driversHos({ since, realSecPerSimDay }) {
  const result = await pool.query(SQL.DRIVERS_HOS_SQL, [since, realSecPerSimDay])
  return result.rows
}

export async function driverDayLog({ driverId, realSecPerSimDay, dayOffset }) {
  const result = await pool.query(SQL.DRIVER_DAY_LOG_SQL, [driverId, realSecPerSimDay, dayOffset])
  return result.rows[0] ?? null
}

export async function findDriver(driverId) {
  const result = await pool.query(SQL.DRIVER_EXISTS_SQL, [driverId])
  return result.rows[0] ?? null
}

export async function violationsSource({ since, realSecPerSimDay }) {
  const result = await pool.query(SQL.VIOLATIONS_SQL, [since, realSecPerSimDay])
  return result.rows
}

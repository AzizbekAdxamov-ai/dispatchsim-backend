// Data access for /compliance. duty_events reads live here alongside the
// two writes 49 CFR 395.32 puts on the carrier: assign (an original marked
// 'inactive-changed' plus a replacement row) and annotate (an annotation on
// the original). Both run on a client from withTransaction so the two
// statements of an assign land together -- dutyEvents.sql.js keeps owning
// the table's other writes.

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

// Optional client: the service's review reads must see the same rows the
// transaction it runs in sees (a test's rolled-back fixture included).
export async function findDriver(driverId, client = null) {
  const result = await (client ?? pool).query(SQL.DRIVER_EXISTS_SQL, [driverId])
  return result.rows[0] ?? null
}

export async function violationsSource({ since, realSecPerSimDay }) {
  const result = await pool.query(SQL.VIOLATIONS_SQL, [since, realSecPerSimDay])
  return result.rows
}

// The review queue, grouped by truck and simulated day. Optional client,
// like the lookups above -- a test's rolled-back transaction must be able
// to see its own fixture here.
export async function unassignedHos({ realSecPerSimDay, daysBack }, client = null) {
  const result = await (client ?? pool).query(SQL.UNASSIGNED_HOS_SQL, [realSecPerSimDay, daysBack])
  return result.rows
}

export async function findDutyEvent(eventId, client = null) {
  const result = await (client ?? pool).query(SQL.UNIDENTIFIED_EVENT_SQL, [eventId])
  return result.rows[0] ?? null
}

// Marks the original 'inactive-changed'. Returns null when the record is
// not an active unidentified one -- the caller decides what that means.
export async function markInactiveChanged(client, eventId) {
  const result = await client.query(SQL.ASSIGN_UNIDENTIFIED_EVENT_SQL, [eventId])
  return result.rows[0] ?? null
}

// The replacement row in the driver's name. Returns null when the same
// driver already has an active log starting at that instant (037's
// one-active-start guard) -- a conflict, not an error.
export async function insertReplacement(client, { driverId, loadId, truckId, status, startedAt, endedAt, annotation }) {
  const result = await client.query(SQL.ASSIGN_REPLACEMENT_EVENT_SQL, [
    driverId, loadId, truckId, status, startedAt, endedAt, annotation,
  ])
  return result.rows[0] ?? null
}

// Annotates the original. Returns null when the record is not active.
export async function annotateEvent(client, { eventId, annotation }) {
  const result = await client.query(SQL.ANNOTATE_UNIDENTIFIED_EVENT_SQL, [eventId, annotation])
  return result.rows[0] ?? null
}

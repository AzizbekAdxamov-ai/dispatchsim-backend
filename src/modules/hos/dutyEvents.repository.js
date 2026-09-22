// Data access for `duty_events` (migration 037). The ONLY file that writes
// SQL against that table -- same "one file owns one table's writes" rule
// as stopVisits.repository.js.

import * as SQL from './dutyEvents.sql.js'

export async function insertMany(client, rows) {
  let inserted = 0
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop -- a run is a few dozen
    // rows; see stopVisits.repository.js's insertMany.
    const result = await client.query(SQL.INSERT_DUTY_EVENT_SQL, [
      r.driverId, r.loadId ?? null, r.truckId ?? null, r.status, r.startedAt, r.endedAt,
      r.routeOffsetMi ?? null, r.facilityId ?? null,
    ])
    if (result.rows.length > 0) inserted += 1
  }
  return inserted
}

export async function recentForDriver(client, { driverId, since }) {
  const result = await client.query(SQL.RECENT_FOR_DRIVER_SQL, [driverId, since])
  return result.rows
}

export async function recentForWorkingDrivers(client, { since }) {
  const result = await client.query(SQL.RECENT_FOR_WORKING_DRIVERS_SQL, [since])
  return result.rows
}

export async function updateDriverHos(client, { driverId, dutyStatus, hosRemainingMin, hoursTodayMin, hoursWeekMin }) {
  const result = await client.query(SQL.UPDATE_DRIVER_HOS_SQL, [
    driverId, dutyStatus, hosRemainingMin, hoursTodayMin, hoursWeekMin,
  ])
  return result.rows[0] ?? null
}

export async function trimForCancelledLoad(client, loadId) {
  const removed = await client.query(SQL.DELETE_FUTURE_FOR_LOAD_SQL, [loadId])
  const ended = await client.query(SQL.END_CURRENT_FOR_LOAD_SQL, [loadId])
  return { removed: removed.rows.length, ended: ended.rows.length }
}

export async function forLoad(client, loadId) {
  const result = await client.query(SQL.FOR_LOAD_SQL, [loadId])
  return result.rows
}

export async function cutLoadAt(client, { loadId, at }) {
  const removed = await client.query(SQL.DELETE_FROM_AT_FOR_LOAD_SQL, [loadId, at])
  const ended = await client.query(SQL.END_AT_FOR_LOAD_SQL, [loadId, at])
  return { removed: removed.rows.length, ended: ended.rows.length }
}

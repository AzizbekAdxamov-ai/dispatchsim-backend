import { query } from '../../db/pool.js'
import * as SQL from './loadEvents.sql.js'

export async function inTransitLoads(client, limit = 50) {
  const runner = client ?? { query }
  const result = await runner.query(SQL.IN_TRANSIT_LOADS_SQL, [limit])
  return result.rows
}

// Returns null when this load already has an open event -- the normal
// case on a busy tick, not a failure.
export async function raiseEvent(client, { loadId, eventType, place }) {
  const result = await client.query(SQL.RAISE_EVENT_SQL, [loadId, eventType, place])
  return result.rows[0] ?? null
}

export async function openEvent(loadId) {
  const result = await query(SQL.OPEN_EVENT_SQL, [loadId])
  return result.rows[0] ?? null
}

export async function claimEvent(client, eventId) {
  const result = await client.query(SQL.CLAIM_EVENT_SQL, [eventId])
  return result.rows[0] ?? null
}

export async function resolveEvent(client, eventId, applied) {
  const result = await client.query(SQL.RESOLVE_EVENT_SQL, [
    eventId, applied.key, applied.hours, applied.extraMiles,
    applied.costUsd, applied.accessorialUsd,
  ])
  return result.rows[0] ?? null
}

export async function extendEta(client, loadId, seconds) {
  const result = await client.query(SQL.EXTEND_ETA_SQL, [loadId, seconds])
  return result.rows[0] ?? null
}

export async function addAccessorial(client, loadId, label, amountUsd) {
  const result = await client.query(SQL.ADD_ACCESSORIAL_SQL, [loadId, label, amountUsd])
  return result.rows[0] ?? null
}

export async function listForLoad(loadId) {
  const result = await query(SQL.LIST_FOR_LOAD_SQL, [loadId])
  return result.rows
}

export async function openEvents() {
  const result = await query(SQL.OPEN_EVENTS_SQL)
  return result.rows
}

export async function markChecked(client, loadIds) {
  if (loadIds.length === 0) return
  const runner = client ?? { query }
  await runner.query(SQL.MARK_CHECKED_SQL, [loadIds])
}

// Called when a dispatch is undone. Returns the rows it closed so the
// caller can say so rather than doing it silently.
export async function closeEventsForLoad(client, loadId) {
  const result = await client.query(SQL.CLOSE_EVENTS_FOR_LOAD_SQL, [loadId])
  return result.rows
}

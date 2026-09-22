// Data access for `stop_visits` (migration 036). This is the ONLY file
// that writes SQL against that table -- the same "one file owns one
// table's writes" rule facilities.repository.js and routing.repository.js
// already follow. (tracking.repository.js reads it, joined into the
// board's own query -- see stopVisits.sql.js's own header on why that
// read lives there instead of here.)

import * as SQL from './stopVisits.sql.js'

// Takes a checked-out client -- called from inside dispatch.service.js's
// own transaction (the dispatch itself, or the follow-up planning step --
// see dispatch.service.js's own comment on why planning runs in its OWN
// transaction, separate from the dispatch write). Loops one INSERT per
// stop, the same shape facilities.repository.js's insertMany uses for the
// same reason: a handful of rows is not where this call's time goes, and
// ON CONFLICT DO NOTHING makes a re-run of the same plan a no-op rather
// than a duplicate-key error.
export async function insertMany(client, stops) {
  let inserted = 0
  for (const s of stops) {
    // eslint-disable-next-line no-await-in-loop -- see facilities.repository.js's
    // own insertMany for why this loop is not parallelized.
    const result = await client.query(SQL.INSERT_STOP_VISIT_SQL, [
      s.loadId, s.truckId, s.driverId, s.facilityId, s.reason, s.routeOffsetMi,
      s.arrivedAt, s.departedAt, s.gallons ?? null, s.costUsd ?? null,
    ])
    if (result.rows.length > 0) inserted += 1
  }
  return inserted
}

// Unsettled fuel visits that have already arrived -- the tick's own claim,
// FOR UPDATE SKIP LOCKED so two overlapping ticks never settle the same
// visit twice.
export async function claimArrivedFuelVisits(client, limit = 1) {
  const result = await client.query(SQL.CLAIM_ARRIVED_FUEL_VISITS_SQL, [limit])
  return result.rows
}

export async function markSettled(client, id) {
  const result = await client.query(SQL.MARK_SETTLED_SQL, [id])
  return result.rows[0] ?? null
}

export async function deleteUnsettledFrom(client, { loadId, at }) {
  const result = await client.query(SQL.DELETE_UNSETTLED_FROM_SQL, [loadId, at])
  return result.rows.length
}

export async function fuelStopsBefore(client, { loadId, at }) {
  const result = await client.query(SQL.FUEL_BEFORE_SQL, [loadId, at])
  return result.rows[0]?.n ?? 0
}

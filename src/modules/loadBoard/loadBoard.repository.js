// Data-access layer for the `load_postings` table. This is the ONLY file in
// the codebase that writes SQL selecting FROM `load_postings` directly.
//
// Postings are open freight listings on the load board. Unlike loads (which
// represent committed freight), postings use now()-relative timestamps and
// are always fresh.
//
// Deadhead is computed via LEFT JOIN LATERAL against available drivers —
// the same pattern drivers.repository.js uses for truck/load enrichment.
// road_miles() is a SQL function (migration 010) matching cities.js's
// roadMiles() exactly (haversine × 1.18).

import { query } from '../../db/pool.js'

const POSTING_COLUMNS = `
  p.id, p.origin_city AS "originCity", p.origin_state AS "originState",
  p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
  p.origin_lat AS "originLat", p.origin_lon AS "originLon",
  p.destination_lat AS "destinationLat", p.destination_lon AS "destinationLon",
  p.broker, p.commodity,
  p.rate_usd AS "rateUsd", p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
  p.equipment_type AS "equipmentType", p.equipment_length_ft AS "equipmentLengthFt",
  p.posted_at AS "postedAt", p.expires_at AS "expiresAt",
  p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
  p.status
`

// LEFT JOIN LATERAL: find the nearest available (not off-duty, no active
// load) driver to this posting's origin. Returns NULL when no driver has
// coordinates or all eligible drivers are off-duty.
const DEADHEAD_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT d.id, d.name, d.hos_remaining_min AS "hosRemainingMin",
           road_miles(d.current_lat, d.current_lon, p.origin_lat, p.origin_lon)::int AS mi
    FROM drivers d
    WHERE d.current_lat IS NOT NULL
      AND d.current_lon IS NOT NULL
      AND d.duty_status <> 'off'
      AND NOT EXISTS (
        SELECT 1 FROM loads l
        WHERE l.driver_id = d.id AND l.status <> 'done'
      )
    ORDER BY mi ASC
    LIMIT 1
  ) near ON true
`

// CTE: compute deadhead once, use in both SELECT and WHERE/ORDER BY.
// Without the CTE, the deadhead filter would need to duplicate the entire
// JOIN LATERAL, and ORDER BY can't reference a LEFT JOIN alias at the
// same query level in PostgreSQL.
const BASE_CTE = `
  WITH nearest AS (
    SELECT
      p.id,
      road_miles(d.current_lat, d.current_lon, p.origin_lat, p.origin_lon)::int AS deadhead_mi,
      d.id AS driver_id, d.name AS driver_name, d.hos_remaining_min AS driver_hos
    FROM load_postings p
    LEFT JOIN LATERAL (
      SELECT d.id, d.name, d.hos_remaining_min, d.current_lat, d.current_lon
      FROM drivers d
      WHERE d.current_lat IS NOT NULL
        AND d.current_lon IS NOT NULL
        AND d.duty_status <> 'off'
        AND NOT EXISTS (
          SELECT 1 FROM loads l
          WHERE l.driver_id = d.id AND l.status <> 'done'
        )
      ORDER BY road_miles(d.current_lat, d.current_lon, p.origin_lat, p.origin_lon) ASC
      LIMIT 1
    ) d ON true
    WHERE p.status = 'open'
      AND p.posted_at <= now()
      AND p.expires_at > now()
  )
`

function buildFilter({ equipmentType, originState, minRatePerMile, maxDeadheadMi }) {
  const conditions = []
  const params = []

  if (equipmentType) {
    params.push(equipmentType)
    conditions.push(`p.equipment_type = $${params.length}`)
  }

  if (originState) {
    params.push(originState)
    conditions.push(`p.origin_state = $${params.length}`)
  }

  if (minRatePerMile != null) {
    // rate_per_mile = rate_usd / distance_mi, computed in SQL
    params.push(minRatePerMile)
    conditions.push(`(p.rate_usd::numeric / p.distance_mi) >= $${params.length}`)
  }

  if (maxDeadheadMi != null) {
    // COALESCE: postings with no available driver get deadhead_mi = 99999,
    // so they are excluded by the max filter (intentional — user asked for
    // a maximum deadhead, and "no driver" exceeds any reasonable limit).
    params.push(maxDeadheadMi)
    conditions.push(`COALESCE(n.deadhead_mi, 99999) <= $${params.length}`)
  }

  return { conditions, params }
}

function sortClause(sort) {
  switch (sort) {
    case 'ratePerMile': return 'ORDER BY (p.rate_usd::numeric / p.distance_mi) DESC'
    case 'deadhead':    return 'ORDER BY COALESCE(n.deadhead_mi, 99999) ASC'
    case 'pickup':      return 'ORDER BY p.pickup_at ASC'
    case 'posted':
    default:            return 'ORDER BY p.posted_at DESC'
  }
}

export async function listPostings({ equipmentType, originState, minRatePerMile, maxDeadheadMi, sort, limit, offset }) {
  const { conditions, params } = buildFilter({ equipmentType, originState, minRatePerMile, maxDeadheadMi })
  const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const result = await query(
    `${BASE_CTE}
     SELECT ${POSTING_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     WHERE n.id IS NOT NULL
       ${where}
     ${sortClause(sort)}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  return result.rows
}

export async function getPostingById(id) {
  const result = await query(
    `${BASE_CTE}
     SELECT ${POSTING_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     WHERE p.id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

// ---------------------------------------------------------------------
// Booking (write) functions
// ---------------------------------------------------------------------

// Atomic conditional UPDATE — the race-condition gate. Uses the same
// optimistic-locking pattern as invites.repository.js's redeem().
// Returns the booked row on success, null on 0-row UPDATE.
export async function bookPostingAtomically(client, postingId, userId) {
  const result = await client.query(
    `UPDATE load_postings p
       SET status = 'booked',
           booked_by_user_id = $2,
           booked_at = now(),
           updated_at = now()
     WHERE p.id = $1
       AND p.status = 'open'
       AND p.posted_at <= now()
       AND p.expires_at > now()
     RETURNING ${POSTING_COLUMNS}`,
    [postingId, userId],
  )
  return result.rows[0] ?? null
}

// Fetch posting state AFTER a failed atomic UPDATE — used to determine
// which error code to throw (taken / expired / not-found).
export async function getPostingForIdempotent(client, postingId, userId) {
  const result = await client.query(
    `SELECT ${POSTING_COLUMNS},
           booked_by_user_id AS "bookedByUserId",
           booked_load_id AS "bookedLoadId",
           booked_at AS "bookedAt"
     FROM load_postings p WHERE p.id = $1`,
    [postingId],
  )
  return result.rows[0] ?? null
}

// Find the truck assigned to a driver (for server-side truck resolution).
export async function findTruckForDriver(client, driverId) {
  const result = await client.query(
    `SELECT id FROM trucks WHERE driver_id = $1 AND status <> 'maintenance' LIMIT 1`,
    [driverId],
  )
  return result.rows[0]?.id ?? null
}

// Set booked_load_id after the loads INSERT succeeds (separate UPDATE
// because FK requires the loads row to exist first).
export async function setBookedLoadId(client, postingId, loadId) {
  await client.query(
    `UPDATE load_postings SET booked_load_id = $2, updated_at = now() WHERE id = $1`,
    [postingId, loadId],
  )
}

// Collect distinct equipment types from the truck fleet — used to build
// the 'no-matching-equipment' warning after commit.
export async function getFleetEquipmentKeys() {
  const result = await query(
    `SELECT DISTINCT trailer_type AS "trailerType"
     FROM trucks
     WHERE trailer_type IS NOT NULL`,
  )
  return new Set(result.rows.map((r) => r.trailerType))
}

// Check if at least one driver is available (duty_status <> 'off' and
// no active load). Used by the 'no-available-driver' warning.
export async function hasAvailableDriver() {
  const result = await query(
    `SELECT 1 FROM drivers d
     WHERE d.duty_status <> 'off'
       AND d.current_lat IS NOT NULL
       AND d.current_lon IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM loads l
         WHERE l.driver_id = d.id AND l.status IN ('ontime','delayed')
       )
     LIMIT 1`,
  )
  return result.rows.length > 0
}

// Find the nearest available driver to a posting's origin, with HOS.
// Returns { id, name, deadheadMi, hosRemainingMin } or null.
export async function findNearestAvailableDriver(originLat, originLon) {
  const result = await query(
    `SELECT d.id, d.name, d.hos_remaining_min AS "hosRemainingMin",
           road_miles(d.current_lat, d.current_lon, $1, $2)::int AS "deadheadMi"
     FROM drivers d
     WHERE d.duty_status <> 'off'
       AND d.current_lat IS NOT NULL
       AND d.current_lon IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM loads l
         WHERE l.driver_id = d.id AND l.status IN ('ontime','delayed')
       )
     ORDER BY road_miles(d.current_lat, d.current_lon, $1, $2) ASC
     LIMIT 1`,
    [originLat, originLon],
  )
  return result.rows[0] ?? null
}

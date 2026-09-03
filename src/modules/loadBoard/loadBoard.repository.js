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
import { CITIES } from '../../../scripts/seed/cities.js'
import { statesInZone } from '../../constants/zones.js'

const POSTING_COLUMNS = `
  p.id, p.origin_city AS "originCity", p.origin_state AS "originState",
  p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
  p.origin_lat AS "originLat", p.origin_lon AS "originLon",
  p.destination_lat AS "destinationLat", p.destination_lon AS "destinationLon",
  p.broker, p.broker_id AS "brokerId", p.commodity,
  p.rate_usd AS "rateUsd", p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
  p.equipment_type AS "equipmentType", p.equipment_length_ft AS "equipmentLengthFt",
  p.posted_at AS "postedAt", p.expires_at AS "expiresAt",
  p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
  p.status
`

// Broker profile columns. Kept SEPARATE from POSTING_COLUMNS on purpose:
// POSTING_COLUMNS is also used in `UPDATE ... RETURNING`, where no join
// exists and a `b.` reference is a hard error. Only the SELECT queries that
// actually join brokers may add these.
// The MC number and a name to ask for. NOT credit_rating, NOT days_to_pay
// (2026-09-02): a board that prints the rating is passing a verdict, and it
// removes the only reason to ever check a broker. The rating exists — it
// still sets payment terms at booking, and Broker Check will return it to a
// dispatcher who goes and looks it up. It just does not arrive unasked.
const BROKER_COLUMNS = `
  b.mc_number AS "brokerMcNumber",
  b.contact_name AS "brokerContactName"
`

// LEFT JOIN, not INNER: postings generated before migration 013 have
// broker_id NULL and must still be listed — a missing profile shows as null
// fields, never as a vanished row.
const BROKER_JOIN = `LEFT JOIN brokers b ON b.id = p.broker_id`

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

// CTE: compute deadhead from the nearest available driver (fleet-based).
// Used when no fromCity/fromState is specified.
const BASE_CTE_FLEET = `
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

// CTE: compute deadhead from a user-selected point (no driver involved).
// NULLs for driver fields — deadhead is distance from the chosen city.
const BASE_CTE_POINT = (lat, lon) => `
  WITH nearest AS (
    SELECT
      p.id,
      road_miles($1, $2, p.origin_lat, p.origin_lon)::int AS deadhead_mi,
      NULL::text AS driver_id, NULL::text AS driver_name, NULL::int AS driver_hos
    FROM load_postings p
    WHERE p.status = 'open'
      AND p.posted_at <= now()
      AND p.expires_at > now()
  )
`

// Exported for service to pick the right CTE
export function buildBaseCte(fromCity, fromState) {
  if (fromCity && fromState) {
    const city = CITIES.find((c) => c.city === fromCity && c.state === fromState)
    if (!city) {
      // Loud, not silent. The service validates the city before calling, so
      // reaching here means a caller skipped that check. Returning an empty
      // board would hide the mistake — the same "silently wrong instead of
      // loudly wrong" pattern that let the 14,676 mi deadhead sit unnoticed.
      throw new Error(`buildBaseCte: unknown city ${fromCity}, ${fromState}`)
    }
    return { sql: BASE_CTE_POINT(city.lat, city.lon), lat: city.lat, lon: city.lon }
  }
  return { sql: BASE_CTE_FLEET, lat: null, lon: null }
}

function buildFilter({ equipmentType, originState, originZone, destinationZone, minRatePerMile, maxDeadheadMi }) {
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

  // Zone -> the states it covers. No stored column and no join: the zone is
  // derived from the state code, so filtering by zone is filtering by a set
  // of states. A zone and a state filter intersect naturally.
  if (originZone) {
    params.push(statesInZone(originZone))
    conditions.push(`p.origin_state = ANY($${params.length})`)
  }

  if (destinationZone) {
    params.push(statesInZone(destinationZone))
    conditions.push(`p.destination_state = ANY($${params.length})`)
  }

  if (minRatePerMile != null) {
    // rate_per_mile = rate_usd / distance_mi, computed in SQL
    params.push(minRatePerMile)
    conditions.push(`(p.rate_usd::numeric / p.distance_mi) >= $${params.length}`)
  }

  if (maxDeadheadMi != null) {
    // NULL deadhead = distance unknown → exclude from max filter
    // (user asked for a maximum distance, and "unknown" doesn't answer it)
    params.push(maxDeadheadMi)
    conditions.push(`n.deadhead_mi IS NOT NULL AND n.deadhead_mi <= $${params.length}`)
  }

  return { conditions, params }
}

function sortClause(sort) {
  switch (sort) {
    case 'ratePerMile': return 'ORDER BY (p.rate_usd::numeric / p.distance_mi) DESC'
    case 'deadhead':    return 'ORDER BY n.deadhead_mi ASC NULLS LAST'
    case 'pickup':      return 'ORDER BY p.pickup_at ASC'
    case 'posted':
    default:            return 'ORDER BY p.posted_at DESC'
  }
}

export async function listPostings({ equipmentType, originState, originZone, destinationZone, minRatePerMile, maxDeadheadMi, sort, limit, offset, fromCity, fromState }) {
  const { sql: baseCte, lat, lon } = buildBaseCte(fromCity, fromState)

  const { conditions, params } = buildFilter({ equipmentType, originState, originZone, destinationZone, minRatePerMile, maxDeadheadMi })

  // Point CTE uses $1/$2 for lat/lon, so filter params start at $3
  const paramOffset = lat != null ? 2 : 0
  const adjustedConditions = conditions.map((c) =>
    c.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + paramOffset}`),
  )
  const adjustedWhere = adjustedConditions.length > 0 ? `AND ${adjustedConditions.join(' AND ')}` : ''

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const sqlParams = lat != null ? [lat, lon, ...params] : params

  const result = await query(
    `${baseCte}
     SELECT ${POSTING_COLUMNS},
            ${BROKER_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     ${BROKER_JOIN}
     WHERE n.id IS NOT NULL
       ${adjustedWhere}
     ${sortClause(sort)}
     LIMIT $${limitIdx + paramOffset} OFFSET $${offsetIdx + paramOffset}`,
    sqlParams,
  )
  return result.rows
}

// Same deadhead reference point as listPostings: when the caller passes a
// location the distance is measured from there, otherwise from the fleet.
// Without this the detail view would report a different deadhead than the
// row the user clicked.
export async function getPostingById(id, fromCity, fromState) {
  const { sql: baseCte, lat, lon } = buildBaseCte(fromCity, fromState)
  const paramOffset = lat != null ? 2 : 0
  const params = lat != null ? [lat, lon, id] : [id]

  const result = await query(
    `${baseCte}
     SELECT ${POSTING_COLUMNS},
            ${BROKER_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     ${BROKER_JOIN}
     WHERE p.id = $${1 + paramOffset}`,
    params,
  )
  return result.rows[0] ?? null
}

// List cities for the location picker (from cities.js CITIES array)
export function listCities() {
  return CITIES.map((c) => ({ city: c.city, state: c.state }))
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

// A broker's stated days-to-pay, used to derive the load's payment terms at
// booking time. Null when the posting predates migration 013 — the caller
// falls back to the default term rather than failing the booking.
export async function getBrokerDaysToPay(client, brokerId) {
  if (!brokerId) return null
  const result = await client.query('SELECT days_to_pay FROM brokers WHERE id = $1', [brokerId])
  return result.rows[0]?.days_to_pay ?? null
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

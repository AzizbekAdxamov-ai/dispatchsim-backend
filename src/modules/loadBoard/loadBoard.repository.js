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
  -- rate_usd is sent as NULL when the posting is "call for rate".
  -- Suppressed HERE rather than in the UI: a number that reaches the
  -- browser has been published, whatever the component chooses to draw,
  -- and the whole point of this posting is that the student has to ask.
  -- The broker still knows it -- brokerChat reads the column directly.
  CASE WHEN p.rate_hidden THEN NULL ELSE p.rate_usd END AS "rateUsd",
  CASE WHEN p.rate_hidden THEN NULL ELSE p.rate_basis END AS "rateBasis",
  CASE WHEN p.rate_hidden THEN NULL ELSE p.fuel_surcharge_usd END AS "fuelSurchargeUsd",
  CASE WHEN p.rate_hidden OR p.rate_basis = 'all-in' THEN NULL ELSE p.rate_usd - p.fuel_surcharge_usd END AS "linehaulUsd",
  p.rate_hidden AS "rateHidden",
  p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
  p.equipment_type AS "equipmentType", p.equipment_length_ft AS "equipmentLengthFt",
  p.posted_at AS "postedAt", p.expires_at AS "expiresAt",
  p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
  p.status
  ,EXISTS (SELECT 1 FROM broker_blocks bb WHERE bb.broker_id = p.broker_id AND bb.blocked_until > now()) AS "blockedByBroker"
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
const BASE_CTE_POINT = (latPh, lonPh) => `
  WITH nearest AS (
    SELECT
      p.id,
      road_miles(${latPh}, ${lonPh}, p.origin_lat, p.origin_lon)::int AS deadhead_mi,
      NULL::text AS driver_id, NULL::text AS driver_name, NULL::int AS driver_hos
    FROM load_postings p
    WHERE p.status = 'open'
      AND p.posted_at <= now()
      AND p.expires_at > now()
  )
`

// Placeholders, numbered once.
//
// Every fragment below asks this for its placeholder instead of counting
// $1, $2, $3 by hand. The previous version built the filter starting at $1
// and then rewrote every placeholder with a regex when the point CTE had
// taken $1 and $2 -- which worked only as long as exactly one fragment
// needed parameters of its own. The search bar needs four (origin point,
// destination point, filters, paging), and a renumbering pass over four
// fragments is a bug waiting for the fifth.
//
// `values.push` returns the new length, which is exactly the number the
// placeholder needs.
function params() {
  const values = []
  return {
    values,
    add(value) {
      return `$${values.push(value)}`
    },
  }
}

// The city a distance is measured from (or to). Loud on a miss, for the
// same reason the old buildBaseCte was: the service validates the city
// before calling, so an unknown one here means a caller skipped that
// check, and an empty board would hide it.
function pointFor(city, state, where) {
  if (!city || !state) return null
  const found = CITIES.find((c) => c.city === city && c.state === state)
  if (!found) throw new Error(`${where}: unknown city ${city}, ${state}`)
  return found
}

// Exported for service to pick the right CTE
export function buildBaseCte(fromCity, fromState, p) {
  const point = pointFor(fromCity, fromState, 'buildBaseCte')
  if (point) {
    return { sql: BASE_CTE_POINT(p.add(point.lat), p.add(point.lon)), point }
  }
  return { sql: BASE_CTE_FLEET, point: null }
}

// DH-D: how far the load's DESTINATION is from the destination that was
// searched for. Null when no destination was given -- the column is not
// "zero miles", it is "not asked".
//
// The expression is built once and used in both the SELECT and the WHERE,
// reusing the same two placeholders: a WHERE clause cannot refer to a
// column alias, and computing it twice from two more parameters would let
// the filter and the displayed number drift apart.
function destinationDistance(toCity, toState, p) {
  const point = pointFor(toCity, toState, 'destinationDistance')
  if (!point) return null
  return `road_miles(${p.add(point.lat)}, ${p.add(point.lon)}, p.destination_lat, p.destination_lon)::int`
}

// Everything the query bar can narrow by, EXCEPT the two deadhead radii.
// Those are separated out because the result count is stated twice -- the
// loads inside the radii, and the ones that match everything else and lie
// outside them -- and the second number is only meaningful if the radii
// are the only difference between the two.
function buildFilter({
  equipmentType, originState, originZone, destinationState, destinationZone,
  minRatePerMile, maxLengthFt, maxWeightLbs, pickupFrom, pickupBefore,
}, p) {
  const conditions = []

  if (equipmentType && equipmentType.length > 0) {
    // One type or several: the query bar lets a dispatcher with a reefer
    // that can also run dry van ask for both at once.
    conditions.push(`p.equipment_type = ANY(${p.add(equipmentType)})`)
  }

  if (originState) {
    conditions.push(`p.origin_state = ${p.add(originState)}`)
  }

  if (destinationState) {
    conditions.push(`p.destination_state = ${p.add(destinationState)}`)
  }

  // Zone -> the states it covers. No stored column and no join: the zone is
  // derived from the state code, so filtering by zone is filtering by a set
  // of states. A zone and a state filter intersect naturally.
  if (originZone) {
    conditions.push(`p.origin_state = ANY(${p.add(statesInZone(originZone))})`)
  }

  if (destinationZone) {
    conditions.push(`p.destination_state = ANY(${p.add(statesInZone(destinationZone))})`)
  }

  if (minRatePerMile != null) {
    // rate_per_mile = rate_usd / distance_mi, computed in SQL.
    //
    // A hidden-rate posting is EXCLUDED by this filter rather than tested
    // against its hidden number. Testing it would answer the question the
    // posting exists to make the student ask: set the minimum to $3.00,
    // and a "call for rate" load that survives the filter has told you it
    // pays at least $3.00. Excluding is the honest reading anyway -- the
    // board does not know the rate, so it cannot say the load clears a
    // floor. The filter is off by default, and the student can clear it to
    // see those loads again.
    conditions.push(
      `(p.rate_hidden = false AND (p.rate_usd::numeric / p.distance_mi) >= ${p.add(minRatePerMile)})`,
    )
  }

  // Length and weight are the TRUCK's limits, not a wish: a 48 ft trailer
  // cannot take a 53 ft load, and a tractor already carrying weight cannot
  // take more than it can carry. So both read as a maximum.
  if (maxLengthFt != null) {
    conditions.push(`p.equipment_length_ft <= ${p.add(maxLengthFt)}`)
  }

  if (maxWeightLbs != null) {
    conditions.push(`p.weight_lbs <= ${p.add(maxWeightLbs)}`)
  }

  // The pickup window: lower bound inclusive, upper bound exclusive, both
  // instants. See the schema for why the exclusive one is named for it.
  if (pickupFrom != null) {
    conditions.push(`p.pickup_at >= ${p.add(pickupFrom)}`)
  }

  if (pickupBefore != null) {
    conditions.push(`p.pickup_at < ${p.add(pickupBefore)}`)
  }

  return conditions
}

// The two radii, kept apart from buildFilter -- see its header.
function buildRadiusFilter({ maxDeadheadMi, maxDeadheadDestMi }, destExpr, p) {
  const conditions = []

  if (maxDeadheadMi != null) {
    // NULL deadhead = distance unknown -> exclude from max filter
    // (user asked for a maximum distance, and "unknown" doesn't answer it)
    conditions.push(`n.deadhead_mi IS NOT NULL AND n.deadhead_mi <= ${p.add(maxDeadheadMi)}`)
  }

  // Without a destination there is no DH-D to be inside or outside of, so
  // the radius is not applied at all rather than excluding everything.
  if (maxDeadheadDestMi != null && destExpr) {
    conditions.push(`${destExpr} <= ${p.add(maxDeadheadDestMi)}`)
  }

  return conditions
}

function sortClause(sort) {
  switch (sort) {
    // Hidden-rate postings sort LAST, not by their hidden number.
    //
    // Ordering is a channel. Suppressing rate_usd in the SELECT while
    // still sorting on it would have let a student read the rate off the
    // row's position -- sort by $/mi, and the "call for rate" load sitting
    // between a $3.10 and a $3.05 is a $3.07 load. The whole point of the
    // posting is that the only way to learn the number is to ask for it.
    case 'rate':
      return 'ORDER BY p.rate_hidden ASC, p.rate_usd DESC'
    case 'ratePerMile':
      return 'ORDER BY p.rate_hidden ASC, (p.rate_usd::numeric / p.distance_mi) DESC'
    case 'deadhead':    return 'ORDER BY n.deadhead_mi ASC NULLS LAST'
    case 'pickup':      return 'ORDER BY p.pickup_at ASC'
    case 'posted':
    default:            return 'ORDER BY p.posted_at DESC'
  }
}

function andAll(conditions) {
  return conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''
}

// Built, not run -- so that scripts/sql-check.js can PREPARE the exact
// string this module executes against the real schema. A statement this
// dynamic has no other way to be parse-checked, and a mis-numbered
// placeholder or a renamed column would otherwise surface in a chat
// window rather than in a command.
export function buildListPostingsSql(filters) {
  const p = params()
  const { sql: baseCte } = buildBaseCte(filters.fromCity, filters.fromState, p)
  const destExpr = destinationDistance(filters.toCity, filters.toState, p)
  const conditions = [
    ...buildFilter(filters, p),
    ...buildRadiusFilter(filters, destExpr, p),
  ]
  const limitPh = p.add(filters.limit)
  const offsetPh = p.add(filters.offset)

  const text = `${baseCte}
     SELECT ${POSTING_COLUMNS},
            ${BROKER_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            ${destExpr ?? 'NULL::int'} AS "deadheadDestMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     ${BROKER_JOIN}
     WHERE n.id IS NOT NULL
       ${andAll(conditions)}
     ${sortClause(filters.sort)}
     LIMIT ${limitPh} OFFSET ${offsetPh}`

  return { text, values: p.values }
}

// Two numbers, one pass over the same rows:
//
//   matching  -- everything the query bar asked for, radii included.
//   nearby    -- matches every other filter and falls OUTSIDE the radii.
//
// The board states both because they answer different questions. "232
// results" is what the truck can reach today; the second number is what
// the same search would find if the dispatcher widened the circle, and it
// is the difference between an empty lane and a lane that is busy 200
// miles away.
export function buildCountPostingsSql(filters) {
  const p = params()
  const { sql: baseCte } = buildBaseCte(filters.fromCity, filters.fromState, p)
  // Only when the radius actually needs it. The list query always shows a
  // DH-D column so it always computes the expression; counting never
  // shows one, and binding the destination's coordinates to a statement
  // that does not mention them is a bind-parameter error at runtime --
  // on the ordinary search that names a destination without narrowing by
  // distance to it.
  const destExpr = filters.maxDeadheadDestMi != null
    ? destinationDistance(filters.toCity, filters.toState, p)
    : null
  const conditions = buildFilter(filters, p)
  const radius = buildRadiusFilter(filters, destExpr, p)
  const inRadius = radius.length > 0 ? radius.map((c) => `(${c})`).join(' AND ') : 'true'

  const text = `${baseCte}
     SELECT count(*) FILTER (WHERE ${inRadius})::int AS "matching",
            count(*)::int AS "withoutRadius"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     WHERE n.id IS NOT NULL
       ${andAll(conditions)}`

  return { text, values: p.values }
}

export async function listPostings(filters) {
  const { text, values } = buildListPostingsSql(filters)
  const result = await query(text, values)
  return result.rows
}

export async function countPostings(filters) {
  const { text, values } = buildCountPostingsSql(filters)
  const row = (await query(text, values)).rows[0]
  return { matching: row.matching, nearby: row.withoutRadius - row.matching }
}

// Same deadhead reference point as listPostings: when the caller passes a
// location the distance is measured from there, otherwise from the fleet.
// Without this the detail view would report a different deadhead than the
// row the user clicked.
export async function getPostingById(id, fromCity, fromState, toCity, toState) {
  const p = params()
  const { sql: baseCte } = buildBaseCte(fromCity, fromState, p)
  const destExpr = destinationDistance(toCity, toState, p)
  const idPh = p.add(id)

  const result = await query(
    `${baseCte}
     SELECT ${POSTING_COLUMNS},
            ${BROKER_COLUMNS},
            n.deadhead_mi AS "deadheadMi",
            ${destExpr ?? 'NULL::int'} AS "deadheadDestMi",
            n.driver_id AS "nearestDriverId",
            n.driver_name AS "nearestDriverName",
            n.driver_hos AS "nearestDriverHosRemainingMin"
     FROM load_postings p
     LEFT JOIN nearest n ON n.id = p.id
     ${BROKER_JOIN}
     WHERE p.id = ${idPh}`,
    p.values,
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
     RETURNING ${POSTING_COLUMNS}, p.rate_usd AS "rateUsd", p.rate_basis AS "rateBasis", p.fuel_surcharge_usd AS "fuelSurchargeUsd"`,
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
         WHERE l.driver_id = d.id AND l.status IN ('ontime','warn','crit')
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
         WHERE l.driver_id = d.id AND l.status IN ('ontime','warn','crit')
       )
     ORDER BY road_miles(d.current_lat, d.current_lon, $1, $2) ASC
     LIMIT 1`,
    [originLat, originLon],
  )
  return result.rows[0] ?? null
}

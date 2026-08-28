// Data-access layer for the `drivers` table. This is the ONLY file in the
// codebase that writes SQL selecting FROM/writing INTO `drivers` directly.
//
// It also LEFT JOIN LATERALs against `trucks` and `loads` to attach each
// driver's assigned truck and current (not-yet-delivered) load in a single
// round trip — the exact pattern users.repository.js already uses to pull
// `roles` from `user_roles` via LATERAL even though userRoles.repository.js
// is the sole WRITER of that table (see its header comment: "the ONLY file
// ... allowed to write SQL"). A read-only enrichment JOIN embedded in the
// owning table's query is not the same thing as a second file writing
// INSERT/UPDATE/DELETE against `trucks`/`loads` — those still live only in
// trucks.repository.js and loads.repository.js respectively. A multi-row
// list scoped to one driver (recentLoads[] on GET /drivers/:id) is NOT
// pulled in here — that is a real `loads` listing query, so it lives in
// loads.repository.js as listLoadsByDriverId() and drivers.service.js
// calls it directly, same as it would for currentLoad if that ever grew
// past a single-row lookup.
//
// Rules enforced here, same as users.repository.js:
//   - Never `SELECT *`.
//   - Every value goes through a parameterized placeholder ($1, ...).
//   - snake_case columns are aliased to camelCase in SQL.

import { query } from '../../db/pool.js'

const DRIVER_COLUMNS = `
  d.id, d.name, d.email, d.phone,
  d.cdl_class          AS "cdlClass",
  d.cdl_number         AS "cdlNumber",
  d.license_expires_on AS "licenseExpiresOn",
  d.home_base_city     AS "homeBaseCity",
  d.home_base_state    AS "homeBaseState",
  d.current_location   AS "currentLocation",
  d.duty_status        AS "dutyStatus",
  d.hos_remaining_min  AS "hosRemainingMin",
  d.hours_today_min    AS "hoursTodayMin",
  d.hours_week_min     AS "hoursWeekMin",
  d.total_miles        AS "totalMiles",
  d.safety_rating      AS "safetyRating",
  d.broker_rating_x10  AS "brokerRatingX10",
  d.pay_model          AS "payModel",
  d.pay_percent_bp     AS "payPercentBp",
  d.pay_per_mile_cents AS "payPerMileCents",
  d.created_at         AS "createdAt",
  d.updated_at         AS "updatedAt"
`

// One truck at most per driver (trucks.driver_id is UNIQUE). NULL when the
// driver has no truck assigned right now.
const TRUCK_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', t.id, 'make', t.make, 'model', t.model, 'year', t.year,
      'status', t.status, 'currentLocation', t.current_location
    ) AS truck
    FROM trucks t
    WHERE t.driver_id = d.id
    LIMIT 1
  ) truck_row ON true
`

// At most one undelivered load per driver (loads_one_active_per_driver_idx
// enforces this in the schema), so LIMIT 1 here is a safety net, not the
// thing doing the real work.
const CURRENT_LOAD_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', l.id, 'status', l.status, 'broker', l.broker,
      'originCity', l.origin_city, 'originState', l.origin_state,
      'destinationCity', l.destination_city, 'destinationState', l.destination_state,
      'rateUsd', l.rate_usd, 'distanceMi', l.distance_mi,
      'pickupAt', l.pickup_at, 'deliveryAt', l.delivery_at, 'etaAt', l.eta_at
    ) AS "currentLoad"
    FROM loads l
    WHERE l.driver_id = d.id AND l.status <> 'done'
    LIMIT 1
  ) current_load_row ON true
`

const ROW_SELECT = `
  SELECT ${DRIVER_COLUMNS}, truck_row.truck AS truck, current_load_row."currentLoad" AS "currentLoad"
  FROM drivers d
  ${TRUCK_LATERAL}
  ${CURRENT_LOAD_LATERAL}
`

// Full roster, newest-hired-looking-first is meaningless here (no hire
// date) — ordered by name, matching how the mock roster read top to
// bottom. `/drivers` is deliberately NOT paginated (see the plan's
// Endpointlar §"Sahifalash"): ~30 drivers is one screenful, so `limit`
// only exists as a future-proofing ceiling the frontend never sends today.
export async function listDrivers({ limit = 100, offset = 0 } = {}) {
  const result = await query(
    `${ROW_SELECT}
     ORDER BY d.name ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return result.rows
}

export async function getDriverById(id) {
  const result = await query(`${ROW_SELECT} WHERE d.id = $1`, [id])
  return result.rows[0] ?? null
}

// Counts by duty_status, for the "meta.counts" the plan's Endpointlar table
// requires on GET /drivers. A single COUNT(*) FILTER query, same shape as
// users.repository.js's countUsers/countPending pair.
export async function countDriverStatuses() {
  const result = await query(
    `SELECT
       count(*)::int                                            AS total,
       count(*) FILTER (WHERE duty_status = 'driving')::int      AS driving,
       count(*) FILTER (WHERE duty_status = 'on-duty')::int      AS "onDuty",
       count(*) FILTER (WHERE duty_status = 'resting')::int      AS resting,
       count(*) FILTER (WHERE duty_status = 'off')::int          AS off
     FROM drivers`,
  )
  return result.rows[0]
}

// Total driver count + how many are "available" right now (not currently
// behind the wheel, and not holding an undelivered load) — the dashboard's
// "Drivers available" tile. The `loads` EXISTS subquery is the same
// read-only cross-table check the CURRENT_LOAD_LATERAL above already does,
// not a second writer of `loads` (see the ownership note at the top of
// this file).
export async function getAvailabilityCounts() {
  const result = await query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (
         WHERE duty_status <> 'driving'
           AND NOT EXISTS (SELECT 1 FROM loads l WHERE l.driver_id = drivers.id AND l.status <> 'done')
       )::int AS available
     FROM drivers`,
  )
  return result.rows[0]
}

// Data-access layer for the `trucks` table. This is the ONLY file in the
// codebase that writes SQL selecting FROM/writing INTO `trucks` directly.
// It also LEFT JOIN LATERALs a compact driver summary onto each row — the
// same read-only enrichment pattern documented at the top of
// drivers.repository.js.

import { query } from '../../db/pool.js'

const TRUCK_COLUMNS = `
  t.id, t.make, t.model, t.year, t.odometer_mi AS "odometerMi", t.status,
  t.driver_id AS "driverId", t.current_location AS "currentLocation",
  t.fuel_pct AS "fuelPct", t.fuel_gallons AS "fuelGallons",
  t.fuel_capacity_gal AS "fuelCapacityGal",
  t.last_fueled_at AS "lastFueledAt", t.last_fueled_location AS "lastFueledLocation",
  t.tire_front_pct AS "tireFrontPct", t.tire_rear_pct AS "tireRearPct",
  t.trailer_type AS "trailerType",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"
`

const DRIVER_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('id', d.id, 'name', d.name) AS driver
    FROM drivers d WHERE d.id = t.driver_id
  ) driver_row ON true
`

const ROW_SELECT = `
  SELECT ${TRUCK_COLUMNS}, driver_row.driver AS driver
  FROM trucks t
  ${DRIVER_LATERAL}
`

// /fleet/trucks is not paginated (~15 trucks, one screenful — see the
// plan's Endpointlar §"Sahifalash").
export async function listTrucks({ limit = 100, offset = 0 } = {}) {
  const result = await query(
    `${ROW_SELECT}
     ORDER BY t.id ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return result.rows
}

export async function getTruckById(id) {
  const result = await query(`${ROW_SELECT} WHERE t.id = $1`, [id])
  return result.rows[0] ?? null
}

// meta for GET /fleet/trucks: counts by status + fleet-wide average fuel
// level, one round trip.
export async function getTruckSummary() {
  const result = await query(
    `SELECT
       count(*)::int                                          AS total,
       count(*) FILTER (WHERE status = 'active')::int          AS active,
       count(*) FILTER (WHERE status = 'maintenance')::int      AS maintenance,
       count(*) FILTER (WHERE status = 'idle')::int             AS idle,
       round(avg(fuel_pct))::int                                AS "avgFuelPct"
     FROM trucks`,
  )
  return result.rows[0]
}

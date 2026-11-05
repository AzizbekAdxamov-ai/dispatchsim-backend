// Data-access layer for the `trucks` table. This is the ONLY file in the
// codebase that writes SQL selecting FROM/writing INTO `trucks` directly.
// It also LEFT JOIN LATERALs a compact driver summary onto each row — the
// same read-only enrichment pattern documented at the top of
// drivers.repository.js.

import { query } from '../../db/pool.js'
import { placeLabel } from '../loads/whereabouts.js'

import { DAILY_DISTANCE_CAP_MI, DAILY_GALLONS_CAP, TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI } from '../../constants/truckWear.js'
import {
  LOCK_TRUCK_FOR_RUN_SQL, APPLY_RUN_TO_TRUCK_SQL, REFUEL_TRUCK_SQL,
} from './fleet.sql.js'

// The CHECK bounds these constants must agree with live in migrations 006
// and 009; test/truckWear.test.js reads those files and fails if the numbers
// here ever drift from them.

const TRUCK_COLUMNS = `
  t.id, t.make, t.model, t.year, t.odometer_mi AS "odometerMi", t.status,
  t.driver_id AS "driverId", t.current_location AS "currentLocation",
  t.fuel_pct AS "fuelPct", t.fuel_gallons AS "fuelGallons",
  t.fuel_capacity_gal AS "fuelCapacityGal",
  t.last_fueled_at AS "lastFueledAt", t.last_fueled_location AS "lastFueledLocation",
  t.tire_front_pct AS "tireFrontPct", t.tire_rear_pct AS "tireRearPct",
  t.trailer_type AS "trailerType", t.trailer_length_ft AS "trailerLengthFt",
  -- Spec sheet, carried over from the listing at purchase (migration 020).
  -- This is the page you check before putting 44,000 lbs behind it.
  t.vin, t.engine_make AS "engineMake", t.engine_model AS "engineModel",
  t.horsepower, t.transmission, t.sleeper, t.suspension,
  t.axle_config AS "axleConfig", t.wheelbase_in AS "wheelbaseIn",
  t.front_axle_lbs AS "frontAxleLbs", t.rear_axle_lbs AS "rearAxleLbs",
  t.gvwr_lbs AS "gvwrLbs", t.has_apu AS "hasApu",
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

export async function getTruckById(id, client = null) {
  // client: the same opts.client seam every reader takes -- a test's
  // rollback transaction reads its own uncommitted fixture through it.
  const runner = client ?? { query }
  const result = await runner.query(`${ROW_SELECT} WHERE t.id = $1`, [id])
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

// ---------------------------------------------------------------------
// What a run does to the truck (migration era 032+)
// ---------------------------------------------------------------------
// Every function here takes the transaction's client. A truck updated
// outside the delivery transaction is a truck updated for a load the tick
// may retry -- the odometer would climb twice while the ledger shows one
// delivery.

// Row-level lock, held to the end of the caller's transaction. Two ticks
// overlapping on two loads for the same truck serialize here; the second
// sees the odometer the first already wrote.
export async function lockTruckForRun(client, truckId) {
  const result = await client.query(LOCK_TRUCK_FOR_RUN_SQL, [truckId])
  return result.rows[0] ?? null
}

// One UPDATE per delivery, not four. fuel_pct is recomputed in the same
// statement from the same gallons that are being written -- two columns,
// one fact, and no window where the gauge and the tank disagree. The
// odometer cap mirrors trucks_odometer's 2,000,000 bound: a truck that
// reaches it is a fleet that has run this simulator far past any lesson,
// and the cap keeps a long-lived company from wedging every future
// delivery on a CHECK violation.
export async function applyRunToTruck(client, {
  truckId, roadMiles, gallonsFromTank, frontTirePoints, rearTirePoints, endedAtLabel = null,
}) {
  // Second guard, behind the caller's: a label like "undefined, undefined"
  // would be coalesced straight into current_location. It becomes NULL (the
  // old location stands) and a warning -- not a throw, which would roll back
  // the delivery and retry it on every tick forever.
  let label = endedAtLabel
  if (label != null) {
    const [city, state, ...rest] = String(label).split(', ')
    if (rest.length > 0 || !placeLabel(city, state)) {
      console.warn(`applyRunToTruck: invalid location label ${JSON.stringify(label)} for truck ${truckId}`)
      label = null
    }
  }
  const result = await client.query(APPLY_RUN_TO_TRUCK_SQL, [
    truckId, roadMiles, gallonsFromTank, frontTirePoints, rearTirePoints, label,
  ])
  return result.rows[0] ?? null
}

// Fill the tank toward `toGallons`, never past the tank. Returns the tank
// level AFTER the fill; the caller computes gallonsAdded against the level
// it read under lock before calling (a RETURNING expression cannot mix the
// old and new values of one column). Returns null when the truck does not
// exist.
export async function refuelTruck(client, { truckId, toGallons }) {
  const result = await client.query(REFUEL_TRUCK_SQL, [truckId, toGallons])
  return result.rows[0] ?? null
}

export { DAILY_DISTANCE_CAP_MI, DAILY_GALLONS_CAP, TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI }

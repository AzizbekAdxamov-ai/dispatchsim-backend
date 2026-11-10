// Data-access layer for the `truck_listings` table. This is the ONLY file
// that writes SQL selecting FROM/writing INTO `truck_listings` directly.

import { query } from '../../db/pool.js'

const LISTING_COLUMNS = `
  l.id, l.make, l.model, l.year, l.odometer_mi AS "odometerMi",
  l.price_usd AS "priceUsd", l.trailer_type AS "trailerType",
  l.fuel_capacity_gal AS "fuelCapacityGal",
  l.tire_front_pct AS "tireFrontPct", l.tire_rear_pct AS "tireRearPct",
  l.service_notes AS "serviceNotes", l.seller,
  l.vin, l.engine_make AS "engineMake", l.engine_model AS "engineModel",
  l.horsepower, l.transmission, l.sleeper, l.suspension,
  l.axle_config AS "axleConfig", l.wheelbase_in AS "wheelbaseIn",
  l.front_axle_lbs AS "frontAxleLbs", l.rear_axle_lbs AS "rearAxleLbs",
  l.gvwr_lbs AS "gvwrLbs", l.has_apu AS "hasApu",
  l.location_city AS "locationCity", l.location_state AS "locationState",
  l.posted_at AS "postedAt", l.expires_at AS "expiresAt",
  l.status, l.bought_truck_id AS "boughtTruckId",
  l.bought_by_user_id AS "boughtByUserId", l.bought_at AS "boughtAt",
  l.created_at AS "createdAt", l.updated_at AS "updatedAt"
`

const ROW_SELECT = `SELECT ${LISTING_COLUMNS} FROM truck_listings l`

export async function listOpenListings({ limit = 100, offset = 0 } = {}) {
  const result = await query(
    `${ROW_SELECT}
     WHERE l.status = 'open' AND l.posted_at <= now() AND l.expires_at > now()
     ORDER BY l.posted_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return result.rows
}

export async function getListingById(id) {
  const result = await query(`${ROW_SELECT} WHERE l.id = $1`, [id])
  return result.rows[0] ?? null
}

export async function buyListing(client, { listingId, userId, truckId }) {
  // 1. Atomically mark listing as bought
  const updateResult = await client.query(
    `UPDATE truck_listings
       SET status = 'bought',
           bought_truck_id = $1,
           bought_by_user_id = $2,
           bought_at = now(),
           updated_at = now()
     WHERE id = $3
       AND status = 'open'
       AND posted_at <= now()
       AND expires_at > now()
     RETURNING id`,
    [truckId, userId, listingId],
  )
  return updateResult.rowCount
}

// The spec sheet is copied onto the truck, not left behind on the
// listing. A page that can tell you whether a truck may legally take
// 44,000 lbs is exactly the fleet page, and the listing is gone the
// moment it is bought.
export async function insertTruck(client, listing) {
  const {
    id, make, model, year, odometerMi, trailerType, fuelCapacityGal,
    tireFrontPct, tireRearPct,
    vin, engineMake, engineModel, horsepower, transmission, sleeper,
    suspension, axleConfig, wheelbaseIn, frontAxleLbs, rearAxleLbs,
    gvwrLbs, hasApu, locationCity, locationState,
  } = listing

  const result = await client.query(
    `INSERT INTO trucks (
       id, make, model, year, odometer_mi, status, trailer_type,
       fuel_capacity_gal, fuel_pct, fuel_gallons,
       tire_front_pct, tire_rear_pct,
       vin, engine_make, engine_model, horsepower, transmission, sleeper,
       suspension, axle_config, wheelbase_in, front_axle_lbs,
       rear_axle_lbs, gvwr_lbs, has_apu, current_location
     ) VALUES ($1, $2, $3, $4, $5, 'idle', $6, $7, 50, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     RETURNING id`,
    [id, make, model, year, odometerMi, trailerType, fuelCapacityGal,
     Math.round(fuelCapacityGal * 0.5), tireFrontPct, tireRearPct,
     vin ?? null, engineMake ?? null, engineModel ?? null, horsepower ?? null,
     transmission ?? null, sleeper ?? null, suspension ?? null,
     axleConfig ?? null, wheelbaseIn ?? null, frontAxleLbs ?? null,
     rearAxleLbs ?? null, gvwrLbs ?? null, hasApu ?? null,
     // Where it is parked becomes where the truck currently is. It does
     // not teleport to you when you pay for it.
     locationCity && locationState ? `${locationCity}, ${locationState}` : null],
  )
  return result.rows[0]
}

export async function assignDriver(client, { truckId, driverId }) {
  // 1. Check truck is idle and has no driver
  const truckResult = await client.query(
    `SELECT id, status, driver_id, is_leased FROM trucks WHERE id = $1 FOR UPDATE`,
    [truckId],
  )
  const truck = truckResult.rows[0]
  if (!truck) return { error: 'TRUCK_NOT_FOUND' }
  if (truck.status !== 'idle') return { error: 'TRUCK_NOT_IDLE' }
  if (truck.driver_id) return { error: 'TRUCK_HAS_DRIVER' }

  // 2. Check driver has no truck
  const driverResult = await client.query(
    `SELECT id FROM trucks WHERE driver_id = $1`,
    [driverId],
  )
  if (driverResult.rows.length > 0) return { error: 'DRIVER_HAS_TRUCK' }

  // 3. Assign
  // The truck goes to where the driver is now (it does not stay in the lot
  // it was parked at), and a leased truck's rent starts from this moment.
  await client.query(
    `UPDATE trucks t
        SET driver_id = d.id, status = 'active', updated_at = now(),
            current_location = COALESCE(NULLIF(btrim(d.current_location), ''),
              CASE WHEN d.current_city IS NOT NULL AND d.current_state IS NOT NULL
                   THEN d.current_city || ', ' || d.current_state END, t.current_location),
            location_city = COALESCE(d.current_city, t.location_city),
            location_state = COALESCE(d.current_state, t.location_state),
            lease_billed_through = CASE WHEN t.is_leased THEN now() END,
            lease_accrued_usd = 0
       FROM drivers d
      WHERE d.id = $1 AND t.id = $2`,
    [driverId, truckId],
  )

  return { ok: true }
}

// Takes the driver off their truck. Refused while a load is still moving on
// it. A leased truck's rent up to now is written first (billTruck, flush),
// then the watermark is cleared so a parked truck costs nothing. The status
// goes back to idle by the trucks_park_on_release trigger (053).
export async function unassignDriver(client, { driverId, billLease = null }) {
  const found = await client.query(
    `SELECT id, trailer_type, is_leased, lease_billed_through, lease_accrued_usd
       FROM trucks WHERE driver_id = $1 FOR UPDATE`,
    [driverId],
  )
  const truck = found.rows[0]
  if (!truck) return { error: 'DRIVER_HAS_NO_TRUCK' }
  const active = await client.query(
    `SELECT 1 FROM loads
      WHERE (driver_id = $1 OR truck_id = $2) AND status NOT IN ('done', 'cancelled', 'neutral') LIMIT 1`,
    [driverId, truck.id],
  )
  if (active.rows.length > 0) return { error: 'TRUCK_HAS_ACTIVE_LOAD' }
  if (billLease && truck.is_leased && truck.lease_billed_through) await billLease(client, truck)
  await client.query(
    `UPDATE trucks SET driver_id = NULL, lease_billed_through = NULL, lease_accrued_usd = 0, updated_at = now() WHERE id = $1`,
    [truck.id],
  )
  return { ok: true, truckId: truck.id }
}

export async function countOpenListings() {
  const result = await query(
    `SELECT count(*)::int AS total FROM truck_listings
     WHERE status = 'open' AND posted_at <= now() AND expires_at > now()`,
  )
  return result.rows[0].total
}

// Data-access layer for the `truck_listings` table. This is the ONLY file
// that writes SQL selecting FROM/writing INTO `truck_listings` directly.

import { query } from '../../db/pool.js'

const LISTING_COLUMNS = `
  l.id, l.make, l.model, l.year, l.odometer_mi AS "odometerMi",
  l.price_usd AS "priceUsd", l.trailer_type AS "trailerType",
  l.fuel_capacity_gal AS "fuelCapacityGal",
  l.tire_front_pct AS "tireFrontPct", l.tire_rear_pct AS "tireRearPct",
  l.service_notes AS "serviceNotes", l.seller,
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

export async function insertTruck(client, { id, make, model, year, odometerMi, trailerType, fuelCapacityGal, tireFrontPct, tireRearPct }) {
  const result = await client.query(
    `INSERT INTO trucks (
       id, make, model, year, odometer_mi, status, trailer_type,
       fuel_capacity_gal, fuel_pct, fuel_gallons,
       tire_front_pct, tire_rear_pct
     ) VALUES ($1, $2, $3, $4, $5, 'idle', $6, $7, 50, $8, $9, $10)
     RETURNING id`,
    [id, make, model, year, odometerMi, trailerType, fuelCapacityGal,
     Math.round(fuelCapacityGal * 0.5), tireFrontPct, tireRearPct],
  )
  return result.rows[0]
}

export async function assignDriver(client, { truckId, driverId }) {
  // 1. Check truck is idle and has no driver
  const truckResult = await client.query(
    `SELECT id, status, driver_id FROM trucks WHERE id = $1 FOR UPDATE`,
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
  await client.query(
    `UPDATE trucks SET driver_id = $1, status = 'active', updated_at = now() WHERE id = $2`,
    [driverId, truckId],
  )

  return { ok: true }
}

export async function countOpenListings() {
  const result = await query(
    `SELECT count(*)::int AS total FROM truck_listings
     WHERE status = 'open' AND posted_at <= now() AND expires_at > now()`,
  )
  return result.rows[0].total
}

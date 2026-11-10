// Business logic for the /fleet/truck-listings endpoints. Combines
// truckListings.repository.js — no SQL lives here, only shaping.

import { pool, withTransaction } from '../../db/pool.js'
import config from '../../config.js'
import { billTruck } from './truckLease.service.js'
import * as truckListingsRepo from './truckListings.repository.js'
import { AppError } from '../../lib/errors.js'
import { findCity } from '../../../scripts/seed/cities.js'
import * as cash from '../cash/cash.service.js'

export async function listOpenListings({ limit }) {
  const listings = await truckListingsRepo.listOpenListings({ limit })
  const total = await truckListingsRepo.countOpenListings()
  return { listings, meta: { total } }
}

export async function getListingById(id) {
  const listing = await truckListingsRepo.getListingById(id)
  if (!listing) {
    throw new AppError('LISTING_NOT_FOUND')
  }
  return listing
}

export async function buyListing({ listingId, userId }) {
  const listing = await truckListingsRepo.getListingById(listingId)

  // Pre-flight checks — use NOT_FOUND for future listings (privacy)
  if (!listing || new Date(listing.postedAt) > new Date()) {
    throw new AppError('LISTING_NOT_FOUND')
  }
  if (listing.status !== 'open') {
    throw new AppError('LISTING_ALREADY_BOUGHT')
  }
  if (new Date(listing.expiresAt) <= new Date()) {
    throw new AppError('LISTING_EXPIRED')
  }

  // Generate plate number
  const plateResult = await pool.query(
    `SELECT 'TX-' || lpad(nextval('bought_truck_plate_seq')::text, 4, '0') || '-BP' AS plate`
  )
  const plate = plateResult.rows[0].plate

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Insert truck
    // The whole listing goes through: the spec sheet has to survive the
    // purchase, and naming fifteen fields here would mean adding a
    // sixteenth in two places the next time one is added.
    const truck = await truckListingsRepo.insertTruck(client, { ...listing, id: plate })

    // Mark listing as bought
    const updated = await truckListingsRepo.buyListing(client, {
      listingId,
      userId,
      truckId: plate,
    })

    // The money leaves in the SAME transaction as the truck arriving.
    // A truck on the yard that nobody paid for, or a payment with no
    // truck, are both worse than the purchase failing outright.
    // assertCanSpend inside this lets the balance go negative -- that is
    // the credit line, and the interest is the lesson -- and refuses only
    // past the limit, where a real lender would decline too.
    // Can the company commit at all? assertCanSpend below asks whether
    // THIS debit fits the line; this asks whether a company whose
    // liabilities exceed its assets should be buying another truck. The
    // lender declines, not the program.
    await cash.assertCanCommit(client, 'buying a truck')

    await cash.spend(client, {
      kind: 'truck_purchase',
      amountUsd: listing.priceUsd,
      description: `${listing.year} ${listing.make} ${listing.model} — ${plate}`,
      refType: 'truck',
      refId: plate,
      userId,
    })

    if (updated === 0) {
      await client.query('ROLLBACK')
      // Race condition: someone else bought it
      const freshListing = await truckListingsRepo.getListingById(listingId)
      if (!freshListing || freshListing.status !== 'open') {
        throw new AppError('LISTING_ALREADY_BOUGHT')
      }
      throw new AppError('LISTING_EXPIRED')
    }

    await client.query('COMMIT')
    return { truck, listing: { ...listing, status: 'bought', boughtTruckId: plate } }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function assignDriver({ truckId, driverId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const result = await truckListingsRepo.assignDriver(client, { truckId, driverId })

    if (result.error) {
      await client.query('ROLLBACK')
      throw new AppError(result.error)
    }

    await client.query('COMMIT')
    return { ok: true }
  } catch (err) {
    await client.query('ROLLBACK')
    // The driver check above is a plain SELECT, so two dispatchers assigning
    // the same driver to different trucks can both pass it. trucks.driver_id
    // is UNIQUE, so the database still refuses the second one — this turns
    // that refusal into the right message instead of a raw 500.
    if (err.code === '23505' && err.constraint === 'trucks_driver_id_key') {
      throw new AppError('DRIVER_HAS_TRUCK')
    }
    throw err
  } finally {
    client.release()
  }
}

// Unassign runs in one transaction with the final lease charge, so the rent
// and the release succeed or fail together. FINANCE=off writes no rent.
export async function unassignDriver({ driverId }, { enabled = config.financeEnabled, run = withTransaction } = {}) {
  return run(async (client) => {
    const result = await truckListingsRepo.unassignDriver(client, {
      driverId,
      billLease: enabled ? (c, truck) => billTruck(c, truck, new Date(), { flush: true }) : null,
    })
    if (result.error) throw new AppError(result.error)
    return { ok: true, truckId: result.truckId }
  })
}

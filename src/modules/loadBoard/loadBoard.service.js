// Business logic for the load board read + booking endpoints.
//
// The booking flow is the first real write endpoint in the project. It
// follows the invites.module.js redeem() pattern: atomic conditional
// UPDATE → race-condition handling → load creation → FK link → warnings.

import { withTransaction } from '../../db/pool.js'
import * as loadBoardRepo from './loadBoard.repository.js'
import * as cash from '../cash/cash.service.js'
import * as loadsRepo from '../../modules/loads/loads.repository.js'
import { AppError } from '../../lib/errors.js'
import { findCity } from '../../../scripts/seed/cities.js'
import { termsForDaysToPay } from '../../constants/paymentTerms.js'
import { getAgreedRate } from '../brokerChat/brokerChat.repository.js'
import { marketFacts } from '../../constants/marketRates.js'

// ---------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------

// The market a posting sits in, attached on the way out: what freight
// leaving its origin pays this week, and what freight leaving its
// destination pays -- the reload the truck will be hunting for. Computed
// from the posting's own states and equipment (src/constants/
// marketRates.js), never stored: the benchmark is the week's, the posting
// is the broker's. null for equipment DAT does not report.
export function withMarket(posting) {
  return {
    ...posting,
    market: marketFacts({
      originState: posting.originState,
      destinationState: posting.destinationState,
      equipmentType: posting.equipmentType,
    }),
  }
}

export async function listPostings(input) {
  const { page, limit, fromCity, fromState, toCity, toState } = input

  // Both reference points are validated here, before any SQL is built --
  // the repository throws loudly on an unknown city rather than returning
  // an empty board, and that throw is for a caller that skipped this.
  if (fromCity && fromState && !findCity(fromCity, fromState)) throw new AppError('UNKNOWN_CITY')
  if (toCity && toState && !findCity(toCity, toState)) throw new AppError('UNKNOWN_CITY')

  const filters = { ...input, offset: (page - 1) * limit }

  // One page of rows and the two counts behind it. Counted rather than
  // inferred from the page: `postings.length` is the page size, never the
  // size of the answer, and a board that says "25 results" on every
  // search has told the dispatcher nothing about the lane.
  const [postings, counts] = await Promise.all([
    loadBoardRepo.listPostings(filters),
    loadBoardRepo.countPostings(filters),
  ])

  // Where the deadhead is measured FROM, so the column can say it. A
  // location if one was searched, otherwise the nearest available driver
  // -- and naming the driver is the point: "48 miles" means something
  // different depending on whose truck it is.
  let deadheadFrom = null
  if (fromCity && fromState) {
    deadheadFrom = { kind: 'location', city: fromCity, state: fromState }
  } else if (postings.length > 0 && postings[0].nearestDriverId) {
    deadheadFrom = { kind: 'driver', driverId: postings[0].nearestDriverId, driverName: postings[0].nearestDriverName }
  }

  const deadheadTo = toCity && toState ? { city: toCity, state: toState } : null

  return {
    postings: postings.map(withMarket),
    meta: {
      page,
      limit,
      deadheadFrom,
      deadheadTo,
      // What the search found, and what the same search would find with
      // the radius widened. Stated, not acted on: the board does not
      // widen anything by itself.
      total: counts.matching,
      nearby: counts.nearby,
    },
  }
}

export async function getPostingById(id, { fromCity, fromState, toCity, toState } = {}) {
  if (fromCity && fromState && !findCity(fromCity, fromState)) throw new AppError('UNKNOWN_CITY')
  if (toCity && toState && !findCity(toCity, toState)) throw new AppError('UNKNOWN_CITY')

  const posting = await loadBoardRepo.getPostingById(id, fromCity, fromState, toCity, toState)
  if (!posting) {
    throw new AppError('POSTING_NOT_FOUND')
  }
  return withMarket(posting)
}

// ---------------------------------------------------------------------
// Booking (POST /load-board/:id/book)
// ---------------------------------------------------------------------

// Generate a 6-digit load ID from the booked_load_id_seq sequence.
async function nextLoadId(client) {
  const result = await client.query(`SELECT lpad(nextval('booked_load_id_seq')::text, 6, '0') AS id`)
  return result.rows[0].id
}

// Post-commit warning checks — OUTSIDE the transaction, always run.
async function collectWarnings(posting, driverId) {
  const warnings = []

  // no-available-driver: query DB instead of checking driverId param.
  // A dispatcher may book without a driver; only warn if the entire
  // fleet has nobody available (off-duty or all actively loaded).
  const driverAvailable = await loadBoardRepo.hasAvailableDriver()
  if (!driverAvailable) {
    warnings.push('no-available-driver')
  }

  const fleetKeys = await loadBoardRepo.getFleetEquipmentKeys()
  if (!fleetKeys.has(posting.equipmentType)) {
    warnings.push('no-matching-equipment')
  }

  // tight-pickup-window: pickup within 4 hours OR nearest driver can't
  // reach origin before pickup (HOS budget < drive time).
  // Drive time ≈ deadheadMi / 55 mph; needed minutes = deadheadMi / 55 * 60.
  let tightWindow = false
  if (posting.pickupAt) {
    const hoursUntilPickup = (new Date(posting.pickupAt).getTime() - Date.now()) / 3_600_000
    if (hoursUntilPickup <= 4) {
      tightWindow = true
    }
  }
  if (!tightWindow && posting.originLat != null && posting.originLon != null) {
    const nearest = await loadBoardRepo.findNearestAvailableDriver(posting.originLat, posting.originLon)
    if (nearest) {
      const driveTimeMin = (nearest.deadheadMi / 55) * 60
      if (driveTimeMin > nearest.hosRemainingMin) {
        tightWindow = true
      }
    }
  }
  if (tightWindow) {
    warnings.push('tight-pickup-window')
  }

  return warnings
}

/**
 * Book a posting. Returns { load, posting, warnings } for both 201 and 200.
 * Throws AppError on failure.
 */
export async function bookPosting({ postingId, userId, driverId, agreement = null }) {
  let posting
  let loadId
  let isIdempotent = false

  try {
    await withTransaction(async (client) => {
      // Step 0: is the company in a position to take on freight at all?
      //
      // A booking costs nothing at the moment it is made, so the cash
      // guard on spending never sees it -- which is how a company deep
      // past its credit line could keep accepting loads it had no way to
      // fund. Fuel and a driver's settlement come due on delivery
      // whatever the balance says.
      await cash.assertCanCommit(client, 'booking a load')

      // Step 1: Atomic conditional UPDATE (the race-condition gate)
      posting = await loadBoardRepo.bookPostingAtomically(client, postingId, userId)

      if (!posting) {
        // Fix 1: 0 rows — determine why with proper priority
        const existing = await loadBoardRepo.getPostingForIdempotent(client, postingId, userId)

        if (!existing) {
          throw new AppError('POSTING_NOT_FOUND')
        }

        // Idempotent repeat: same user, already booked
        if (existing.status === 'booked' && existing.bookedByUserId === userId) {
          posting = existing
          loadId = existing.bookedLoadId
          isIdempotent = true
          return // exits withTransaction — ROLLBACK follows (no data changed)
        }

        // Booked by someone else
        if (existing.status === 'booked') {
          throw new AppError('POSTING_TAKEN')
        }

        // Expired
        if (existing.expiresAt <= new Date()) {
          throw new AppError('POSTING_EXPIRED')
        }

        // posted_at in the future — treat as not found (not taken, not expired)
        throw new AppError('POSTING_NOT_FOUND')
      }

      const agreedRate = await getAgreedRate(client, postingId, userId, agreement)
      // A held or renegotiated chat cannot race a signature into a posted-price booking.
      if (agreement && agreedRate === null) throw new AppError('NOT_AGREED_YET')

      // Step 2: posting is now 'booked'. Generate load ID.
      loadId = await nextLoadId(client)

      // Fix 4: resolve truck server-side if driverId is provided
      let resolvedTruckId = null
      if (driverId) {
        resolvedTruckId = await loadBoardRepo.findTruckForDriver(client, driverId)
      }

      // Step 3: Create the load row
      await loadsRepo.createLoad(client, {
        id: loadId,
        originCity: posting.originCity,
        originState: posting.originState,
        destinationCity: posting.destinationCity,
        destinationState: posting.destinationState,
        broker: posting.broker,
        commodity: posting.commodity,
        // If this dispatcher negotiated a rate with the broker before
        // booking, THAT is what the load is worth — not the posted number.
        // Without this the whole conversation would be theatre.
        rateUsd: agreedRate ?? posting.rateUsd,
        distanceMi: posting.distanceMi,
        weightLbs: posting.weightLbs,
        equipmentType: posting.equipmentType,
        equipmentLengthFt: posting.equipmentLengthFt,
        driverId: driverId || null,
        truckId: resolvedTruckId,
        pickupAt: posting.pickupAt,
        deliveryAt: posting.deliveryAt,
        bookedAt: new Date(),
        // The consequence of who you book from. A broker that pays in 68
        // days gets net60 terms, and finance ages the receivable from there —
        // the student books a cheap-looking load from a D-rated broker and
        // feels it two months later. Booking is never blocked; the lesson is
        // in the outcome, not in a disabled button.
        paymentTerms: termsForDaysToPay(
          await loadBoardRepo.getBrokerDaysToPay(client, posting.brokerId),
        ),
      })

      // Step 4: Link posting → load (FK requires load to exist first)
      await loadBoardRepo.setBookedLoadId(client, postingId, loadId)
    })
  } catch (err) {
    // Fix 3: narrow error mapping — only specific known constraints
    if (err.code === '23505' && err.constraint === 'loads_one_active_per_driver_idx') {
      throw new AppError('DRIVER_HAS_ACTIVE_LOAD')
    }
    if (err.code === '23505' && err.constraint === 'loads_pkey') {
      throw new AppError('LOAD_ID_UNAVAILABLE')
    }
    if (err.code === '23514' && err.constraint === 'loads_pending_clean') {
      throw new AppError('DRIVER_NOT_AVAILABLE')
    }
    // All other constraint violations fall through as 500 — the real
    // cause must be visible in logs, not hidden behind a generic message.
    throw err
  }

  // Fix 2: load + posting — same shape for both 201 and 200
  let load
  if (isIdempotent) {
    load = await loadsRepo.getLoadById(loadId)
  } else {
    // load was just created in the transaction — fetch it for the response
    load = await loadsRepo.getLoadById(loadId)
  }

  // Fix 5: always run warnings
  const warnings = await collectWarnings(posting, driverId)

  return { load, posting, warnings, isNew: !isIdempotent }
}

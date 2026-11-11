// HTTP layer for /fleet/truck-listings. No SQL, no business logic — see
// truckListings.service.js and truckListings.repository.js. Every route
// is already behind requireAuth + requireRole('fleet-manager') (see fleet.routes.js).

import * as truckListingsService from './truckListings.service.js'
import { assignDriverSchema, listingsQuerySchema } from './fleet.schemas.js'

export async function listOpenListings(req, res) {
  const { limit } = listingsQuerySchema.parse(req.query)
  const result = await truckListingsService.listOpenListings({ limit })
  res.status(200).json(result)
}

export async function getListing(req, res) {
  const listing = await truckListingsService.getListingById(req.params.id)
  res.status(200).json(listing)
}

export async function buyListing(req, res) {
  const result = await truckListingsService.buyListing({
    listingId: req.params.id,
    userId: req.auth.userId,
  })
  res.status(201).json(result)
}

export async function assignDriver(req, res) {
  // Validated with zod like every other endpoint. The hand-rolled check
  // this replaces answered `{ message }` directly, bypassing errorHandler
  // and the `{ error: { code, message } }` contract the whole client
  // reads -- so a caller matching on err.code got undefined and could not
  // tell a missing field from a network fault.
  const { driverId } = assignDriverSchema.parse(req.body)
  const result = await truckListingsService.assignDriver({
    truckId: req.params.id,
    driverId,
  })
  res.status(200).json(result)
}

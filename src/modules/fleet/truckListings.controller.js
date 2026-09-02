// HTTP layer for /fleet/truck-listings. No SQL, no business logic — see
// truckListings.service.js and truckListings.repository.js. Every route
// is already behind requireAuth + requireRole('fleet-manager') (see fleet.routes.js).

import * as truckListingsService from './truckListings.service.js'

export async function listOpenListings(req, res) {
  const limit = Number(req.query.limit) || 100
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
    userId: req.user.sub,
  })
  res.status(201).json(result)
}

export async function assignDriver(req, res) {
  const { driverId } = req.body
  if (!driverId) {
    return res.status(400).json({ message: 'driverId is required' })
  }
  const result = await truckListingsService.assignDriver({
    truckId: req.params.id,
    driverId,
  })
  res.status(200).json(result)
}

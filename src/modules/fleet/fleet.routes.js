// Route wiring for /fleet/*. Mounted at /fleet in app.js. Gated to the
// `fleet-manager` role specifically — unlike /loads and /drivers, this is
// one of the two areas (with /finance) the plan calls out as legitimately
// role-restricted, since ProtectedRoute gates the frontend routes the same
// way (see the plan's Endpointlar §2).

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as fleetController from './fleet.controller.js'
import * as truckListingsController from './truckListings.controller.js'

const router = Router()

router.use(requireAuth, requireRole('fleet-manager'))

router.get('/trucks', fleetController.listTrucks)
router.get('/trucks/:id', fleetController.getTruck)
router.get('/maintenance', fleetController.listMaintenance)

// Truck listings (market)
router.get('/truck-listings', truckListingsController.listOpenListings)
router.get('/truck-listings/:id', truckListingsController.getListing)
router.post('/truck-listings/:id/buy', truckListingsController.buyListing)

// Truck assignment
router.post('/trucks/:id/assign', truckListingsController.assignDriver)

export default router

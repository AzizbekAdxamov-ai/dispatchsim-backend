// Route wiring for /drivers. Mounted at /drivers in app.js. Open to ANY
// granted role, same reasoning as loads.routes.js.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as driversController from './drivers.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/', driversController.listDrivers)
router.get('/:id', driversController.getDriver)

// Putting a driver in a truck from the driver's own page. Reading the
// options is open to every role on this router, like the page itself;
// the assignment is a write, so it narrows to the two roles whose work
// it is -- the dispatcher, who needs the driver moving, and fleet, who
// owns the trucks and could already do this from the truck's side.
router.get('/:id/truck-options', driversController.truckOptions)
router.post('/:id/truck', requireRole('dispatcher', 'fleet-manager'), driversController.assignTruck)
// Taking the driver off the truck: same two roles; refused while a load is moving on it.
router.delete('/:id/truck', requireRole('dispatcher', 'fleet-manager'), driversController.unassignTruck)

export default router

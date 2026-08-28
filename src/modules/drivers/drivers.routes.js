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

export default router

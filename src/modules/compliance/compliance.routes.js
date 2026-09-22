// /compliance -- hours-of-service views. Dispatcher only: watching a
// driver's clocks is the dispatcher's job in this workspace.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './compliance.controller.js'

const router = Router()

router.use(requireAuth, requireRole('dispatcher'))

router.get('/hos', controller.driverHos)
router.get('/hos/:driverId/log', controller.driverLog)
router.get('/violations', controller.violations)

export default router

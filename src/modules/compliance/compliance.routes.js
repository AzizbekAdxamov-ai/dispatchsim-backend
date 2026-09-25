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

// Driver Qualification files (49 CFR 391 Subpart E) -- read-only. The
// documents age against the sim clock in the service; this endpoint never
// writes, so a hire's missing file shows as a fact, not an error.
router.get('/driver-qualification', controller.driverQualification)

// Compliance > Unassigned HOS -- the carrier's 49 CFR 395.32 review of
// the records the ELD wrote while nobody was signed in (see
// hos/repositioning.js for where those records come from).
router.get('/unassigned-hos', controller.unassignedHos)
router.post('/unassigned-hos/:id/assign', controller.assignUnassignedHos)
router.post('/unassigned-hos/:id/annotate', controller.annotateUnassignedHos)

export default router

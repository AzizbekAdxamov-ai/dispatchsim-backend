// Route wiring for /stats. Mounted at /stats in app.js. Open to ANY
// granted role, same reasoning as loads.routes.js/drivers.routes.js — the
// main dashboard is every role's home page (see roleHomePath in the
// frontend), so it can't be gated to one specific role.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as statsController from './stats.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/dashboard', statsController.getDashboard)

// Compliance > Overview: the operation's cleanliness, composed from the
// readings each compliance module already owns. Nulls for a failed source
// travel as `degraded`, so a missing tile never reads as all-clear.
router.get('/compliance', statsController.getComplianceOverview)

export default router

// Route wiring for /loads. Mounted at /loads in app.js.
//
// Both routes are read-only and open to ANY granted role (requireRole with
// no arguments) — see the plan's Endpointlar §2: gating /loads to just
// `dispatcher` would 403 an `hr` user on their own home page, since
// roleHomePath('hr') is '/' (the dispatcher-shaped dashboard). Only
// /fleet/* and /finance/* are gated to a specific role.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as loadsController from './loads.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/', loadsController.listLoads)
router.get('/:id', loadsController.getLoad)

// Dispatch is dispatcher work, unlike the reads above which every role
// can see.
router.post('/:id/dispatch', requireRole('dispatcher'), loadsController.dispatchLoad)
router.post('/:id/cancel', requireRole('dispatcher'), loadsController.cancelDispatch)

export default router

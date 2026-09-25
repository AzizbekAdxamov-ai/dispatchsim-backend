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
// The pre-flight check travels with the same gating: it shows the facts
// the dispatcher weighs, so it is dispatcher work too.
router.get('/:id/dispatch-check', requireRole('dispatcher'), loadsController.dispatchCheck)
router.post('/:id/dispatch', requireRole('dispatcher'), loadsController.dispatchLoad)
router.post('/:id/cancel', requireRole('dispatcher'), loadsController.cancelDispatch)

// Road events. Reading them is every role's business -- finance wants to
// know why $1,450 left the account -- but choosing what to do about one is
// the dispatcher's job, which is the whole reason the event exists.
router.get('/:id/events', loadsController.listEvents)
router.post('/:id/events/:eventId/resolve', requireRole('dispatcher'), loadsController.resolveEvent)

export default router

// Route wiring for the tracking board. Mounted at /tracking in app.js.
//
// Read-only and open to ANY granted role, like /loads and /drivers: the
// truck's position is a fact every workspace reads (dispatch tracks it,
// finance ages the invoices it produces, fleet owns the truck wearing
// down). Choosing what to DO about the road stays dispatcher-only back on
// the load's own page -- this board answers "where is it", nothing more.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as trackingController from './tracking.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/map', trackingController.map)
router.get('/', trackingController.board)

export default router

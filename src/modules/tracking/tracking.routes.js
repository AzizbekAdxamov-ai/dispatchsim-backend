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
router.get('/cities', trackingController.cityCompletions)
router.get('/lane', trackingController.laneSearch)
// Road geometry for one lane -- read-only, same as everything else on
// this router (see the header above for why the whole board is open to
// every granted role).
router.get('/route', trackingController.route)
// The FULL (unsimplified) geometry for one SELECTED load -- see
// tracking.controller.js's loadRoute and tracking.service.js's
// BOARD_TOLERANCE_MI for why this is a separate on-demand fetch instead
// of a field the 10s board poll always carries. Registered before the
// bare '/' route below, though Express would not actually confuse the
// two (different path shapes) -- kept next to '/route' because it is the
// same kind of endpoint: one lane's road geometry, fetched once.
router.get('/loads/:loadId/route', trackingController.loadRoute)
router.get('/', trackingController.board)

export default router

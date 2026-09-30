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
// The FULL (unsimplified) geometry for one SELECTED load -- see
// tracking.controller.js's loadRoute and tracking.service.js's
// BOARD_TOLERANCE_MI for why this is a separate on-demand fetch instead
// of a field the 10s board poll always carries. Registered before the
// bare '/' route below, though Express would not actually confuse the
// two (different path shapes).
//
// A sibling GET /route used to sit here, serving one lane's road
// geometry to the fleet map's route-alternatives panel. The panel is
// gone (Routes does route planning now) and the endpoint went with it;
// routing.service.js's routesFor() cache is still the thing this and
// the trip planner both read through.
router.get('/loads/:loadId/route', trackingController.loadRoute)
router.get('/', trackingController.board)

export default router

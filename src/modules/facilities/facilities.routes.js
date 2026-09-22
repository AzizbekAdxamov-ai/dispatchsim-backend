// Route wiring for /facilities. Mounted at /facilities in app.js.
//
// Read-only, open to ANY granted role -- like /tracking and /loads: where
// a truck can fuel up is a fact every workspace reads, not a
// dispatcher-only decision (that decision, per the plan header this
// module ships under, is a later task).

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as facilitiesController from './facilities.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/', facilitiesController.list)

export default router

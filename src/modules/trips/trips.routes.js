// /trips -- the route planner (Dispatch > Routes). Dispatcher only.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './trips.controller.js'

const router = Router()

router.use(requireAuth, requireRole('dispatcher'))

router.post('/plan', controller.plan)

export default router

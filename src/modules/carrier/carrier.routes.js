// Route wiring for /carrier. Mounted at /carrier in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import * as controller from './carrier.controller.js'

const router = Router()

// Readable by every role: the name and the MC number are on the paper
// each of them handles -- the dispatcher's rate confirmation, finance's
// invoice, HR's offer letter. Changing them is an administrator's act,
// because renaming the company mid-run rewrites every document it sends.
router.get('/', requireAuth, requireRole(), controller.getCarrier)
router.patch('/', requireAuth, requireAdmin, controller.updateCarrier)

export default router

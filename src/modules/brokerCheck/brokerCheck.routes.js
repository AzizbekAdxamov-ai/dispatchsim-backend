// Route wiring for /broker-check. Mounted at /broker-check in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './brokerCheck.controller.js'

const router = Router()

// Dispatcher-only, same as the chat: vetting a broker is dispatch work.
router.use(requireAuth, requireRole('dispatcher'))

router.get('/', controller.listChecks)
router.post('/', controller.checkMc)

export default router

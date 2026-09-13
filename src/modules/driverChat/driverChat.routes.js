// Route wiring for /driver-chat. Mounted at /driver-chat in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { chatLimiter } from '../../middleware/rateLimit.js'
import * as controller from './driverChat.controller.js'

const router = Router()

// Every role. A finance user who has just seen three drivers waiting on
// pay should be able to read what those drivers actually said about it.
router.use(requireAuth, requireRole())

router.get('/', controller.listThreads)
router.post('/', controller.open)
router.get('/:id', controller.getThread)
// Rate limited like the broker chat. Without it the only guard was a
// daily cap of 60, read and then acted on non-atomically, so a stuck
// client loop could fire sixty model calls in a second before the count
// caught up -- the free tier's whole daily allowance in one burst.
router.post('/:id/messages', chatLimiter, controller.send)

export default router

// Route wiring for /telegram. Mounted at /telegram in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './telegram.controller.js'

const router = Router()

// Every role, like /driver-chat: a link belongs to a person, not a job
// title, and the bridge speaks for whichever account holds it.
router.use(requireAuth, requireRole())

router.get('/status', controller.status)
router.post('/codes', controller.createCode)
router.get('/codes', controller.listCodes)
router.delete('/link', controller.unlink)

export default router

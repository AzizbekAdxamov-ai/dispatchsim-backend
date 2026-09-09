// Route wiring for /alerts. Mounted at /alerts in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './alerts.controller.js'

const router = Router()

// Every role sees the same board. An alert is a fact about the company,
// and a dispatcher who cannot see that the account is under water will
// keep booking cheap freight from slow-paying brokers.
router.use(requireAuth, requireRole())

router.get('/', controller.list)
router.post('/ack', controller.ack)
// POST, not DELETE. The key travels in the body -- it contains a dot and
// a colon, and api/client.js's del() sends no body, so a DELETE here would
// have meant either URL-encoding a key into a path segment or a second
// request shape nothing else in the app uses.
router.post('/unack', controller.unack)

export default router

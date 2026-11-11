// Route wiring for /broker-chat. Mounted at /broker-chat in app.js.
//
// Reads and writes are dispatcher-only: negotiating a rate is dispatch work,
// and unlike the board (which HR and fleet can usefully look at) there is
// nothing here for another role to see.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { chatLimiter, bookLimiter, pdfLimiter } from '../../middleware/rateLimit.js'
import * as controller from './brokerChat.controller.js'

const router = Router()

// Before auth, like the documents routes: see rateLimit.js pdfLimiter.
router.use('/:id/rate-confirmation.pdf', pdfLimiter)

router.use(requireAuth, requireRole('dispatcher'))

router.get('/', controller.listConversations)
router.post('/postings/:postingId', controller.openConversation)
router.post('/loads/:loadId', controller.openLoadConversation)
router.post('/loads/:loadId/cancel', controller.cancelBookingForLoad)
router.get('/:id', controller.getThread)
router.post('/:id/messages', chatLimiter, controller.sendMessage)
router.post('/:id/agree', controller.agreeRate)
router.post('/:id/accept', bookLimiter, controller.acceptRateCon)
router.get('/:id/rate-confirmation.pdf', controller.rateConfirmation)

export default router

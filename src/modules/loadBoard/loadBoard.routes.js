// Route wiring for /load-board. Mounted at /load-board in app.js.
//
// Both routes require authentication and any granted role (requireRole with
// no arguments) — same pattern as loads.routes.js: an HR user should be
// able to see the board (they see what dispatchers see), and gating to
// dispatcher-only would 403 them.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { bookLimiter } from '../../middleware/rateLimit.js'
import * as loadBoardController from './loadBoard.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/', loadBoardController.listPostings)
router.get('/:id', loadBoardController.getPosting)
router.post('/:id/book', requireRole('dispatcher'), bookLimiter, loadBoardController.bookPosting)

export default router

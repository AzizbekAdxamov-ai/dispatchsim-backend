// Route wiring for /load-board. Mounted at /load-board in app.js.
//
// Both routes require authentication and any granted role (requireRole with
// no arguments) — same pattern as loads.routes.js: an HR user should be
// able to see the board (they see what dispatchers see), and gating to
// dispatcher-only would 403 them.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as loadBoardController from './loadBoard.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/cities', loadBoardController.listCities)
router.get('/', loadBoardController.listPostings)
router.get('/:id', loadBoardController.getPosting)
// No POST /:id/book. A load is created by accepting a rate confirmation
// (POST /broker-chat/:id/accept), never by a button on the board — you
// cannot book freight you have not talked to anyone about. bookPosting
// itself lives on in loadBoard.service and is called from there.

export default router

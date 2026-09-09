// Route wiring for /cash. Mounted at /cash in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './cash.controller.js'

const router = Router()

// Readable by every role, not just finance. A dispatcher deciding whether
// to take a cheap load from a slow-paying broker needs to know what the
// account looks like; hiding it behind a role would make the consequence
// invisible to the person causing it.
router.use(requireAuth, requireRole())

router.get('/', controller.getOverview)
router.get('/ledger', controller.listEntries)

export default router

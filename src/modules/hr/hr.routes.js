// Route wiring for /hr. Mounted at /hr in app.js.
//
// Read routes require authentication + any granted role (requireRole with
// no arguments) — dispatchers should be able to see the applicant pool.
// Write route (hire) requires hr role.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { hireLimiter } from '../../middleware/rateLimit.js'
import * as hrController from './hr.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/applicants', hrController.listApplicants)
router.get('/applicants/:id', hrController.getApplicant)
router.post('/applicants/:id/hire', requireRole('hr'), hireLimiter, hrController.hireApplicant)

export default router

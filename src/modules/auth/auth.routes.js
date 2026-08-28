// Route wiring for /auth/*. Mounted at /auth in app.js.

import { Router } from 'express'
import { authLimiter, registerLimiter } from '../../middleware/rateLimit.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import * as authController from './auth.controller.js'

const router = Router()

router.post('/register', registerLimiter, authController.register)
router.post('/login', authLimiter, authController.login)
// No rate limiter here: this is an authenticated read, not a credential
// guess-able endpoint, so it doesn't need brute-force throttling.
router.get('/me', requireAuth, authController.me)
// No rate limiter here either: this only switches between roles the caller
// already has (enforced by usersRepo.setActiveRole's WHERE EXISTS plus the
// deferred users_active_role_fk), so there is no credential/secret here for
// a limiter to protect.
router.patch('/active-role', requireAuth, authController.setActiveRole)

export default router

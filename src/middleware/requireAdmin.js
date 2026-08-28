// Express middleware that gates access to /admin/* routes. Must run AFTER
// requireAuth (it reads req.auth.userId, set by requireAuth).
//
// JWT is never the source of truth for admin access — the token payload
// only carries `sub` and `role` (see lib/token.js) and is never re-issued
// when an admin flag changes, so a token minted before a promotion/demotion
// would otherwise still reflect stale access for up to its full expiry
// window. Every request through this middleware re-reads `is_admin` fresh
// from the database instead, so a demotion (or a promotion) takes effect on
// the very next request, not on next login.

import * as usersRepo from '../modules/auth/users.repository.js'
import { AppError } from '../lib/errors.js'

export async function requireAdmin(req, res, next) {
  try {
    const user = await usersRepo.findAdminFlagById(req.auth.userId)
    if (!user) {
      return next(new AppError('USER_NOT_FOUND'))
    }
    if (user.isAdmin !== true) {
      return next(new AppError('FORBIDDEN'))
    }
    next()
  } catch (err) {
    next(err)
  }
}

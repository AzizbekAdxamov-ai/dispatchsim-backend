// Express middleware factory that gates access to a route by the caller's
// GRANTED role set. Must run AFTER requireAuth (it reads req.auth.userId,
// set by requireAuth). Mirrors requireAdmin.js: roles are re-read fresh
// from the database on every request rather than trusted from the JWT
// (the token only carries `sub` — see lib/token.js), so a role grant or
// revoke by an admin takes effect on the very next request, not on next
// login.
//
// ⚠️ Checks the GRANTED set (`roles`), never `activeRole`. This matches the
// frontend's own ProtectedRoute, which gates on `user.roles.includes(r)`,
// not on whichever workspace happens to be active right now. Gating on
// activeRole instead would turn a student's in-app "switch workspace" click
// into a race: a request already in flight for the OLD active role would
// 403 the instant the switch lands, even though the role itself was never
// revoked.
//
// requireRole() with no arguments means "at least one role must be
// granted" — used on routes every role-holder may read (see the plan's
// Endpointlar table: /loads, /drivers, /stats/dashboard). A user with an
// empty roles set (freshly registered, not yet assigned by an admin) is
// rejected. requireRole('fleet-manager') etc. requires that specific role
// to be among the granted set; requireRole('a', 'b') passes if the caller
// has ANY one of the listed roles.
//
// Deliberately does NOT special-case is_admin: admin access is a permission
// to manage accounts (see migration 002's comment), not a work area, so an
// admin who also wants to use the dispatcher/fleet/finance workspaces must
// be granted that role like anyone else (see admin.service.js).

import * as userRolesRepo from '../modules/auth/userRoles.repository.js'
import { AppError } from '../lib/errors.js'

export function requireRole(...keys) {
  return async function requireRoleMiddleware(req, res, next) {
    try {
      const granted = await userRolesRepo.listByUserId(req.auth.userId)
      const roles = granted.map((row) => row.role)

      const allowed = keys.length === 0 ? roles.length > 0 : roles.some((role) => keys.includes(role))

      if (!allowed) {
        return next(new AppError('FORBIDDEN'))
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

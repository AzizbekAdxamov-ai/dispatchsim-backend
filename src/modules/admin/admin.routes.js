// Route wiring for /admin/*. Mounted at /admin in app.js.
//
// Every route on this router requires both a valid session AND admin
// access — router.use applies both middlewares to everything defined
// below, so a new route added here later can't accidentally be left
// unprotected.
//
// Deliberately no DELETE route for invite codes: this API never deletes an
// invite code through the admin console (users can be deleted, see below).
// Removing a user's access is done by clearing roles/isAdmin via PATCH, and a spent
// or retired invite code is deactivated (`isActive: false`) via PATCH, not
// destroyed — an invite row must survive so user_roles.invite_code_id keeps
// pointing at something real.
//
// POST /users/:id/reset-password replaces a user's password with a one-time
// temporary one (a write, rate-limited like login).

import { Router } from 'express'
import { authLimiter } from '../../middleware/rateLimit.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireAdmin } from '../../middleware/requireAdmin.js'
import * as adminController from './admin.controller.js'

const router = Router()

router.use(requireAuth, requireAdmin)

router.get('/users', adminController.listUsers)
// Must be declared BEFORE '/users/:id': Express matches routes in
// registration order, and '/users/:id' would otherwise treat the literal
// path segment "bulk-roles" as the :id param (failing userIdSchema's UUID
// check instead of ever reaching bulkAssignRoles). They're on different
// HTTP methods today (POST vs PATCH) so this collision is currently
// latent, not live — but the order is kept correct regardless so it never
// becomes a real bug if a method ever changes.
router.post('/users/bulk-roles', adminController.bulkAssignRoles)
router.patch('/users/:id', adminController.updateUser)
router.post('/users/:id/reset-password', authLimiter, adminController.resetPassword)
router.delete('/users/:id', adminController.deleteUser)

router.get('/invites', adminController.listInvites)
router.post('/invites', adminController.createInvite)
router.patch('/invites/:id', adminController.updateInvite)

export default router

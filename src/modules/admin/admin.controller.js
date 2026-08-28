// HTTP layer for admin: parses/validates the request, calls the service,
// and shapes the response. No SQL, no transaction logic here — that lives
// in admin.service.js/invites.service.js and below. Every route this file
// serves is already behind requireAuth + requireAdmin (see
// admin.routes.js).

import {
  listQuerySchema,
  updateUserSchema,
  userIdSchema,
  bulkRolesSchema,
  inviteCreateSchema,
  inviteUpdateSchema,
  inviteListQuerySchema,
  inviteIdSchema,
} from './admin.schemas.js'
import * as adminService from './admin.service.js'
import * as invitesService from './invites.service.js'

export async function listUsers(req, res) {
  const input = listQuerySchema.parse(req.query)
  const result = await adminService.listUsers(input)
  res.status(200).json(result)
}

export async function updateUser(req, res) {
  const targetId = userIdSchema.parse(req.params.id)
  const body = updateUserSchema.parse(req.body)

  // Distinguishes "roles wasn't in the request body at all" from "roles
  // was explicitly set to []" (revoke everything) — both parse to
  // `body.roles === undefined` only for the first; `'roles' in body` is
  // only true when the key was actually sent, which is what
  // adminService.updateUser needs to know whether to touch role state at
  // all.
  const rolesProvided = Object.prototype.hasOwnProperty.call(body, 'roles')

  const user = await adminService.updateUser({
    actorId: req.auth.userId,
    targetId,
    roles: rolesProvided ? body.roles : undefined,
    rolesProvided,
    isAdmin: body.isAdmin,
  })

  res.status(200).json(user)
}

export async function bulkAssignRoles(req, res) {
  const body = bulkRolesSchema.parse(req.body)
  const result = await adminService.bulkAssignRoles({
    actorId: req.auth.userId,
    userIds: body.userIds,
    mode: body.mode,
    roles: body.roles,
  })
  res.status(200).json(result)
}

export async function listInvites(req, res) {
  const input = inviteListQuerySchema.parse(req.query)
  const result = await invitesService.listInvites(input)
  res.status(200).json(result)
}

export async function createInvite(req, res) {
  const body = inviteCreateSchema.parse(req.body)
  const invite = await invitesService.createInvite({
    label: body.label ?? '',
    prefix: body.prefix,
    roles: body.roles,
    expiresAt: body.expiresAt ?? null,
    maxUses: body.maxUses ?? null,
    createdBy: req.auth.userId,
  })
  res.status(201).json(invite)
}

export async function updateInvite(req, res) {
  const id = inviteIdSchema.parse(req.params.id)
  const body = inviteUpdateSchema.parse(req.body)
  const invite = await invitesService.updateInvite(id, body)
  res.status(200).json(invite)
}

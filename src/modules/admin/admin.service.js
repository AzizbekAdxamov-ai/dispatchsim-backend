// Business logic for the admin console: listing users, changing a single
// user's role set/admin access, bulk-assigning roles, and generating/
// managing invite codes. Controllers call into this module; this module is
// the only place that combines the users repository, the user-roles
// repository, and transaction control.

import * as usersRepo from '../auth/users.repository.js'
import * as userRolesRepo from '../auth/userRoles.repository.js'
import { toPublicUser } from '../auth/auth.service.js'
import { withTransaction } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import { pickActiveRole } from '../../constants/roles.js'

export async function listUsers({ filter, search, page, limit }) {
  const offset = (page - 1) * limit

  const [rows, total, pendingCount] = await Promise.all([
    usersRepo.listUsers({ filter, search, limit, offset }),
    usersRepo.countUsers({ filter, search }),
    usersRepo.countPending(),
  ])

  // Route every row through the same public-shape function login/register
  // use, so the admin list can never accidentally expose a column (like the
  // password hash) that toPublicUser is responsible for stripping.
  const users = rows.map((row) => ({ ...toPublicUser(row), createdAt: row.createdAt }))

  return { users, meta: { total, page, limit, pendingCount } }
}

// After a role grant/revoke, active_role may need to change: if it's still
// among the user's granted roles, it's left alone; otherwise it falls back
// to pickActiveRole's ROLE_KEYS-order pick, or null when the user now has
// no roles at all. Shared between updateUser and bulkAssignRoles below so
// the two never compute this differently. Must run with the same `client`
// as the grant/revoke it follows, inside the same transaction.
async function recomputeActiveRole(client, userId) {
  const current = await usersRepo.findById(userId, client)
  if (!current) return null

  const stillGranted = current.activeRole && current.roles.includes(current.activeRole)
  if (stillGranted) {
    return current
  }

  const nextActiveRole = pickActiveRole(current.roles)
  await usersRepo.setActiveRole({ id: userId, role: nextActiveRole }, client)
  return usersRepo.findById(userId, client)
}

export async function updateUser({ actorId, targetId, roles, rolesProvided, isAdmin }) {
  // An admin can never change their OWN admin flag through this endpoint —
  // granting/revoking always requires a second administrator to act on
  // your behalf, which prevents a lone admin from either accidentally
  // locking themselves out or unilaterally rubber-stamping their own
  // access change.
  if (isAdmin !== undefined && targetId === actorId) {
    throw new AppError('SELF_ADMIN_CHANGE')
  }

  const updated = await withTransaction(async (client) => {
    if (isAdmin === false) {
      // Lock every admin row for the rest of this transaction before
      // deciding whether this demotion is safe. Without the lock, two
      // concurrent requests demoting two different admins could each read
      // "2 admins, safe to demote" and both commit, leaving zero admins.
      const adminIds = await usersRepo.lockAdminIds(client)
      if (adminIds.includes(targetId) && adminIds.length === 1) {
        throw new AppError('LAST_ADMIN')
      }
    }

    const existing = await usersRepo.findById(targetId, client)
    if (!existing) {
      return null
    }

    if (isAdmin !== undefined) {
      await usersRepo.setAdminFlag(client, { id: targetId, isAdmin })
    }

    if (rolesProvided) {
      await userRolesRepo.replace(client, { userId: targetId, roles, grantedBy: actorId })
      await recomputeActiveRole(client, targetId)
    }

    return usersRepo.findById(targetId, client)
  })

  if (!updated) {
    throw new AppError('USER_NOT_FOUND')
  }

  return { ...toPublicUser(updated), createdAt: updated.createdAt }
}

// Assigns (or replaces) a role set across many users in one request. Each
// user id is processed in its own transaction, so one failure (a stale/
// deleted id, an unexpected DB error) doesn't roll back the ones that
// already succeeded — the caller gets a per-id status report instead of an
// all-or-nothing 500. Request-level problems (invalid body, not an admin)
// are still ordinary 4xx responses handled before this function is ever
// called.
//
// Deliberately does not touch `isAdmin` at all — see Qaror D in the plan:
// an admin selecting themselves among the target ids is harmless only
// because this endpoint has no way to change admin status.
// ⚠️ If `isAdmin` support is ever added here, the LAST_ADMIN lock pattern
// in updateUser above (lockAdminIds under a single transaction) is NOT
// safe to reuse as-is for a multi-user loop — it would need to run fresh,
// inside its own transaction, for every element of the batch, or two
// concurrent bulk demotions could still race past each other the same way
// the comment on lockAdminIds warns about for the single-user case.
export async function deleteUser({ actorId, targetId }) {
  // Cannot delete yourself
  if (targetId === actorId) {
    throw new AppError('SELF_ADMIN_CHANGE')
  }

  const deleted = await withTransaction(async (client) => {
    // Lock every admin row so concurrent deletes can't race past
    const adminIds = await usersRepo.lockAdminIds(client)
    const existing = await usersRepo.findById(targetId, client)
    if (!existing) {
      return null
    }

    // Cannot delete the last admin
    if (existing.isAdmin && adminIds.length <= 1) {
      throw new AppError('LAST_ADMIN')
    }

    return usersRepo.deleteUser(client, targetId)
  })

  if (!deleted) {
    throw new AppError('USER_NOT_FOUND')
  }

  return { deleted: true, id: targetId }
}

export async function bulkAssignRoles({ actorId, userIds, mode, roles }) {
  const results = []
  let updated = 0

  for (const userId of userIds) {
    // eslint-disable-next-line no-await-in-loop
    const result = await withTransaction(async (client) => {
      const existing = await usersRepo.findById(userId, client)
      if (!existing) {
        return null
      }

      if (mode === 'replace') {
        await userRolesRepo.replace(client, { userId, roles, grantedBy: actorId })
      } else {
        await userRolesRepo.grant(client, { userId, roles, grantedBy: actorId })
      }

      return recomputeActiveRole(client, userId)
    }).catch((err) => {
      console.error(`bulkAssignRoles: failed for user ${userId}`, err)
      return undefined
    })

    if (result === undefined) {
      results.push({ id: userId, status: 'skipped', code: 'INTERNAL_ERROR' })
      continue
    }

    if (result === null) {
      results.push({ id: userId, status: 'skipped', code: 'USER_NOT_FOUND' })
      continue
    }

    results.push({
      id: userId,
      status: 'updated',
      user: { ...toPublicUser(result), createdAt: result.createdAt },
    })
    updated += 1
  }

  return {
    results,
    summary: { requested: userIds.length, updated, skipped: userIds.length - updated },
  }
}

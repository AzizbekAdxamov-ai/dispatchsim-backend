// Data-access layer for the `user_roles` table. This is the ONLY file in
// the codebase that is allowed to write SQL touching `user_roles` — every
// other module goes through the functions exported here (mirrors the rule
// at the top of users.repository.js).
//
// Every function that mutates data takes a `client` (a checked-out
// connection from withTransaction in db/pool.js) rather than the shared
// pool, because a role grant/revoke is always paired with an active_role
// update on `users` in the same caller transaction, and the deferred
// `users_active_role_fk` (migration 003) needs both writes to be visible to
// the same connection at COMMIT time.

import { query } from '../../db/pool.js'

function run(client) {
  return client ? client.query.bind(client) : query
}

// Read-only listing of one user's granted roles with their audit metadata
// (who granted it, when, and via which invite code if any). Safe to call
// outside a transaction.
export async function listByUserId(userId, client) {
  const result = await run(client)(
    `SELECT role, granted_by AS "grantedBy", granted_at AS "grantedAt",
            invite_code_id AS "inviteCodeId"
     FROM user_roles
     WHERE user_id = $1
     ORDER BY role`,
    [userId],
  )
  return result.rows
}

// Grants a set of roles to a user. Rows that already exist are left
// untouched (ON CONFLICT DO NOTHING) — granting a role a user already has
// is a no-op, not an error, and does not overwrite who originally granted
// it or when. `grantedBy`/`inviteCodeId` default to null: registration's
// invite-redemption grant passes `grantedBy: null, inviteCodeId: <id>`, an
// admin's manual grant passes `grantedBy: <adminId>` with no invite, and
// the 003 migration's own backfill (outside this file, run once as raw
// SQL) is the only case where both stay null.
export async function grant(client, { userId, roles, grantedBy = null, inviteCodeId = null }) {
  if (!roles || roles.length === 0) return

  const values = []
  const params = []
  roles.forEach((role, i) => {
    const base = i * 4
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`)
    params.push(userId, role, grantedBy, inviteCodeId)
  })

  await run(client)(
    `INSERT INTO user_roles (user_id, role, granted_by, invite_code_id)
     VALUES ${values.join(', ')}
     ON CONFLICT (user_id, role) DO NOTHING`,
    params,
  )
}

// Removes every role a user has that is NOT in `roles` — the complement of
// grant(), used together to implement "replace with this exact set". When
// `roles` is empty, `role = ANY($2::text[])` is false for every row, so
// every granted role is removed, which is the correct "revoke everything"
// behavior for an admin clearing a user's access entirely.
export async function revokeNotIn(client, { userId, roles }) {
  await run(client)(
    `DELETE FROM user_roles WHERE user_id = $1 AND NOT (role = ANY($2::text[]))`,
    [userId, roles ?? []],
  )
}

// Replaces a user's full role set with exactly `roles`: grants any new ones
// and revokes anything not in the list. Two statements rather than a single
// upsert-and-delete round trip, because grant() must preserve
// granted_by/granted_at/invite_code_id on roles the user already has
// (ON CONFLICT DO NOTHING leaves those columns untouched), while
// revokeNotIn() removes exactly the complement — combining them into one
// statement would force a choice between overwriting that audit trail or
// not being able to express the delete side at all.
export async function replace(client, { userId, roles, grantedBy = null }) {
  await grant(client, { userId, roles, grantedBy })
  await revokeNotIn(client, { userId, roles })
}

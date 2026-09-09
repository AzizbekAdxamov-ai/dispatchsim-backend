// Data-access layer for the `users` table. This is the ONLY file in the
// codebase that is allowed to write SQL touching `users` — every other
// module goes through the functions exported here.
//
// Rules enforced in this file:
//   - Never `SELECT *`: every query names its columns explicitly, so adding
//     a sensitive column later (e.g. a password reset token) never leaks it
//     into a result set by accident.
//   - Every value goes through a parameterized placeholder ($1, $2, ...);
//     nothing is ever concatenated into the SQL string. This includes
//     ILIKE search terms: the `%...%` wrapping happens in JS and the whole
//     wrapped string is still passed as a bound parameter, never spliced
//     into the query text.
//   - snake_case DB columns are aliased to camelCase in SQL (quoted, e.g.
//     `AS "passwordHash"`) so callers work with normal JS object shapes
//     without a separate mapping step.
//
// Multi-role model (migration 003): `role` was renamed to `active_role` —
// it is the user's current STATE (which granted work area they're in right
// now), not the set of work areas they're allowed to use. The set itself
// lives in `user_roles` (see userRoles.repository.js, the only file allowed
// to write SQL against that table) and is joined in here read-only via
// LATERAL so every public user shape carries both `activeRole` and the
// full `roles` array in one round trip.
//
// Every function below takes an optional trailing `client` argument (a
// checked-out connection from withTransaction in db/pool.js). Pass it
// whenever the call is part of a multi-table transaction (e.g.
// registration, which also writes user_roles and possibly invite_codes) —
// omitting it runs the query on the shared pool instead, which is correct
// for a simple standalone read/write but would NOT participate in a
// caller's transaction. The deferred `users_active_role_fk` constraint (see
// migration 003) is checked at COMMIT against whatever a single connection
// saw, so a write on the wrong connection can silently fall outside the
// transaction it was meant to be part of.

import { query } from '../../db/pool.js'

function run(client) {
  return client ? client.query.bind(client) : query
}

// Shared column list for every SELECT that returns a public-safe user row.
// `roles` is aggregated via a LATERAL join (not a GROUP BY) so a user with
// zero rows in user_roles still comes back as `roles: []` instead of being
// silently dropped by an inner join, and so the aggregation stays local to
// the column list instead of being split across SELECT and GROUP BY.
const USER_COLUMNS = `
  u.id, u.email, u.name, u.company,
  u.active_role AS "activeRole", u.is_admin AS "isAdmin",
  u.created_at  AS "createdAt",
  COALESCE(r.roles, '{}') AS roles
`

const USER_ROLES_JOIN = `
  LEFT JOIN LATERAL (
    SELECT array_agg(ur.role ORDER BY ur.role) AS roles
    FROM user_roles ur WHERE ur.user_id = u.id
  ) r ON true
`

// Creates a new user row. Deliberately does NOT accept or write
// `active_role` — a freshly created row always starts with no active role
// and no granted roles; auth.service.js grants roles (via
// userRoles.repository.js) and sets active_role as separate steps of the
// same registration transaction, then re-reads the canonical row with
// findById. `passwordHash` is written but never returned from this query.
export async function create({ email, passwordHash, name, company }, client) {
  const result = await run(client)(
    `INSERT INTO users (email, password_hash, name, company)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, company, created_at AS "createdAt"`,
    [email, passwordHash, name, company],
  )
  return result.rows[0]
}

// Looks a user up by email for login. This is the one lookup that DOES
// include the password hash, because the caller needs it to verify the
// submitted password — callers must not forward this row to a client as-is.
export async function findByEmail(email, client) {
  const result = await run(client)(
    `SELECT ${USER_COLUMNS}, u.password_hash AS "passwordHash"
     FROM users u
     ${USER_ROLES_JOIN}
     WHERE u.email = $1`,
    [email],
  )
  return result.rows[0] ?? null
}

// Looks a user up by id for profile/`me` reads, and as the canonical
// "re-read after write" query used throughout auth.service.js/
// admin.service.js. No password hash column.
export async function findById(id, client) {
  const result = await run(client)(
    `SELECT ${USER_COLUMNS}
     FROM users u
     ${USER_ROLES_JOIN}
     WHERE u.id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

// Minimal lookup used by requireAdmin on every request: reads only the one
// column that decides access, never the full profile. Deliberately its own
// query rather than reusing findById, so the admin gate stays a single
// narrow column read. Untouched by the multi-role change — is_admin is a
// permission, orthogonal to the role/roles model (see migration
// 002_admin_access.sql).
export async function findAdminFlagById(id) {
  const result = await query('SELECT is_admin AS "isAdmin" FROM users WHERE id = $1', [id])
  return result.rows[0] ?? null
}

// Builds the shared WHERE clause + params for listUsers/countUsers so the
// two stay in sync. `filter` is only ever one of exactly three recognized
// keys — anything else (already rejected upstream by admin.schemas.js, but
// guarded again here defensively) behaves like 'all' and adds no condition.
//
// "pending" is now defined as "no row in user_roles at all" rather than a
// NULL column check, matching the new model: a student can only be
// unassigned by having zero granted roles (which also implies
// active_role IS NULL, enforced by the users_active_role_fk).
function buildUserFilter({ filter, search }) {
  const conditions = []
  const params = []

  if (filter === 'pending') {
    conditions.push('NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)')
  } else if (filter === 'admins') {
    conditions.push('u.is_admin')
  }

  if (search) {
    params.push(`%${search}%`)
    const idx = params.length
    conditions.push(`(u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.company ILIKE $${idx})`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { whereClause, params }
}

// Paginated user list for the admin console.
export async function listUsers({ filter, search, limit, offset }) {
  const { whereClause, params } = buildUserFilter({ filter, search })

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const result = await query(
    `SELECT ${USER_COLUMNS}
     FROM users u
     ${USER_ROLES_JOIN}
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  return result.rows
}

// Total row count matching the same filter/search as listUsers, for
// pagination metadata.
export async function countUsers({ filter, search }) {
  const { whereClause, params } = buildUserFilter({ filter, search })

  const result = await query(`SELECT count(*)::int AS count FROM users u ${whereClause}`, params)
  return result.rows[0].count
}

// Count of accounts with no role granted yet, regardless of the current
// list filter/search — used for the admin console's "pending" badge.
export async function countPending() {
  const result = await query(
    `SELECT count(*)::int AS count
     FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`,
  )
  return result.rows[0].count
}

// Locks every admin row for the duration of the caller's transaction (must
// be called with a `client` from withTransaction). Used before demoting an
// admin, so a concurrent demotion of a different admin can't race past this
// one and leave zero admins — both transactions serialize on this lock.
export async function lockAdminIds(client) {
  const result = await client.query('SELECT id FROM users WHERE is_admin = true FOR UPDATE')
  return result.rows.map((row) => row.id)
}

// Sets (or clears) exactly the `is_admin` flag — the role-set update that
// used to live in `updateAccess` now goes through userRoles.repository.js's
// grant/replace + setActiveRole below instead. Must run with a `client`
// inside a transaction when paired with lockAdminIds (see admin.service.js).
export async function setAdminFlag(client, { id, isAdmin }) {
  const result = await client.query(
    `UPDATE users
     SET is_admin = $2, updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [id, isAdmin],
  )
  return result.rows[0] ?? null
}

// Switches active_role, the user's current work-area STATE, subject to the
// application-level half of the two-layer guarantee described in Qaror C/D
// of the plan (the other half is the deferred users_active_role_fk):
//   - `role` non-null: only succeeds if the user already has that exact
//     role granted in user_roles (the EXISTS subquery) — this is the path
//     PATCH /auth/active-role uses, where "not granted" must be rejected.
//   - `role` null: always allowed unconditionally — this is the path
//     admin.service.js uses when a role edit leaves the user with no
//     active role at all (nothing to check membership against).
// Returns null when 0 rows matched, which happens only when `id` doesn't
// exist or (in the non-null case) the role isn't granted — callers that
// need to tell those two apart (auth.service.js's setActiveRole) follow up
// with findById.
export async function setActiveRole({ id, role }, client) {
  const result = await run(client)(
    `UPDATE users u
     SET active_role = $2, updated_at = now()
     WHERE u.id = $1
       AND ($2::text IS NULL OR EXISTS (
         SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = $2
       ))
     RETURNING u.id`,
    [id, role],
  )
  return result.rows[0] ?? null
}

// Permanently deletes a user and cascades through user_roles (CASCADE),
// broker_conversations (CASCADE), broker_checks (CASCADE), and zeroes
// out references in cash_ledger, driver_applicants, invite_codes,
// load_postings, truck_listings, user_roles.granted_by (all SET NULL).
// Must run inside a transaction with lockAdminIds to prevent races.
export async function deleteUser(client, id) {
  const result = await client.query(
    `DELETE FROM users WHERE id = $1 RETURNING id`,
    [id],
  )
  return result.rows[0] ?? null
}

// Grants admin access by email, for the one-off CLI bootstrap script
// (scripts/grant-admin.js). Returns the row it updated, or undefined if no
// user has that email — the caller decides how to report that. Untouched
// by the multi-role change — it only ever touches is_admin.
export async function setAdminByEmail(email) {
  const result = await query(
    `UPDATE users
     SET is_admin = true, updated_at = now()
     WHERE email = $1
     RETURNING email`,
    [email],
  )
  return result.rows[0] ?? null
}

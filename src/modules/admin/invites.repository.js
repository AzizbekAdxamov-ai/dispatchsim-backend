// Data-access layer for the `invite_codes` table. This is the ONLY file in
// the codebase that is allowed to write SQL touching `invite_codes` —
// every other module goes through the functions exported here (mirrors the
// rule at the top of users.repository.js).

import { query } from '../../db/pool.js'

function run(client) {
  return client ? client.query.bind(client) : query
}

const INVITE_COLUMNS = `
  id, code, label, roles,
  expires_at AS "expiresAt", max_uses AS "maxUses", used_count AS "usedCount",
  is_active AS "isActive", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`

// Inserts a new invite code row. `code` must already be the final,
// server-generated string (see lib/inviteCode.js) — this function does not
// generate or validate it beyond what the table's own CHECK constraints
// enforce. On a code collision this throws a raw Postgres error with
// `err.constraint === 'invite_codes_code_key'`; invites.service.js is
// responsible for catching that and retrying, not this file.
export async function create({ code, label, roles, expiresAt, maxUses, createdBy }) {
  const result = await query(
    `INSERT INTO invite_codes (code, label, roles, expires_at, max_uses, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${INVITE_COLUMNS}`,
    [code, label, roles, expiresAt ?? null, maxUses ?? null, createdBy],
  )
  return result.rows[0]
}

export async function findById(id) {
  const result = await query(`SELECT ${INVITE_COLUMNS} FROM invite_codes WHERE id = $1`, [id])
  return result.rows[0] ?? null
}

function buildInviteFilter({ filter }) {
  if (filter === 'active') return 'WHERE is_active'
  if (filter === 'inactive') return 'WHERE NOT is_active'
  return ''
}

export async function list({ filter, limit, offset }) {
  const whereClause = buildInviteFilter({ filter })
  const result = await query(
    `SELECT ${INVITE_COLUMNS}
     FROM invite_codes
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return result.rows
}

export async function count({ filter }) {
  const whereClause = buildInviteFilter({ filter })
  const result = await query(`SELECT count(*)::int AS count FROM invite_codes ${whereClause}`)
  return result.rows[0].count
}

// Partial update: only fields actually present in `patch` are touched.
// `roles` and `code` are deliberately NOT accepted here — see the comment
// on invites.service.js's updateInvite for why they are immutable after
// creation. `isActive` uses COALESCE (boolean has no "not provided" state
// of its own); `expiresAt`/`maxUses` use an explicit `$n::boolean` presence
// flag instead, the same pattern the old updateAccess used for `role`,
// because both fields are legitimately nullable on purpose (clearing an
// expiry or a max-uses cap is a real, intentional update, not "leave
// it alone").
export async function update(id, { isActive, expiresAt, maxUses, label }) {
  const result = await query(
    `UPDATE invite_codes
     SET is_active  = COALESCE($2, is_active),
         expires_at = CASE WHEN $3::boolean THEN $4 ELSE expires_at END,
         max_uses   = CASE WHEN $5::boolean THEN $6 ELSE max_uses END,
         label      = COALESCE($7, label),
         updated_at = now()
     WHERE id = $1
     RETURNING ${INVITE_COLUMNS}`,
    [
      id,
      isActive ?? null,
      expiresAt !== undefined,
      expiresAt ?? null,
      maxUses !== undefined,
      maxUses ?? null,
      label ?? null,
    ],
  )
  return result.rows[0] ?? null
}

// Atomically checks validity (active, not expired, not exhausted) and
// increments the usage counter in one statement, so two concurrent
// registrations racing on the same code — including a single-use one —
// can't both win: PostgreSQL's row lock on the UPDATE serializes them, and
// the loser simply sees 0 rows returned. See Qaror B in the plan. Runs
// inside the caller's transaction via `client` (auth.service.js's register
// passes its transaction client), so if anything later in that
// transaction fails, this increment rolls back too — a failed registration
// never burns a use off the code.
//
// A null return covers four distinct reasons (no such code, inactive,
// expired, exhausted) and deliberately does not distinguish which one to
// the caller — see Qaror B/D: the invite redemption error must not become
// an oracle for probing which of those states a given code string is in.
export async function redeem(client, code) {
  const result = await run(client)(
    `UPDATE invite_codes
       SET used_count = used_count + 1, updated_at = now()
     WHERE code = $1
       AND is_active
       AND (expires_at IS NULL OR expires_at > now())
       AND (max_uses  IS NULL OR used_count < max_uses)
     RETURNING id, roles`,
    [code],
  )
  return result.rows[0] ?? null
}

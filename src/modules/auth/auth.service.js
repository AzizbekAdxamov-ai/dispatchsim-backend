// Business logic for authentication. Controllers call into this module;
// this module is the only place that talks to the users repository, the
// user-roles repository, and the password/token helpers together.

import * as usersRepo from './users.repository.js'
import * as userRolesRepo from './userRoles.repository.js'
import * as invitesRepo from '../admin/invites.repository.js'
import * as password from '../../lib/password.js'
import * as token from '../../lib/token.js'
import { AppError } from '../../lib/errors.js'
import { withTransaction } from '../../db/pool.js'
import { pickActiveRole } from '../../constants/roles.js'
import config from '../../config.js'

// Strips a DB user row down to the shape that is safe to send to a client.
// `passwordHash` (present on rows returned by findByEmail) is deliberately
// left out — callers must always go through this function rather than
// forwarding a repository row directly.
//
// Multi-role shape (see Qaror C in the plan): there is no `role` field at
// all anymore — `roles` is the full granted set (always an array, `[]`
// when none) and `activeRole` is which one of those the user is currently
// working in (`null` only when `roles` is empty).
export function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    roles: row.roles ?? [],
    activeRole: row.activeRole ?? null,
    // Explicit `=== true` rather than passing `row.isAdmin` through as-is,
    // so this is always a real boolean in the response — never `undefined`
    // if a caller ever passes in a row from a query that omitted the
    // column, and never anything but a strict boolean either way.
    isAdmin: row.isAdmin === true,
  }
}

// Registration now writes to three tables (users, user_roles, and
// invite_codes when a code is used) in a single all-or-nothing operation,
// so the whole function runs inside one transaction: every repository call
// below is passed `client` explicitly. If any step throws — including an
// invalid invite code or a duplicate email — nothing from this call is
// persisted.
export async function register(input) {
  // Before the transaction opens: a closed registration writes nothing.
  if (config.requireInvite && !input.invite) {
    throw new AppError('INVITE_REQUIRED')
  }

  const finalRow = await withTransaction(async (client) => {
    let inviteRoles = null
    let inviteCodeId = null

    if (input.invite) {
      // Atomic check-and-increment: see invites.repository.js's redeem()
      // and Qaror B in the plan. A null result covers "no such code",
      // "inactive", "expired", and "exhausted" without distinguishing
      // which — that ambiguity is deliberate, not a shortcut.
      const redeemed = await invitesRepo.redeem(client, input.invite)
      if (!redeemed) {
        throw new AppError('INVITE_INVALID')
      }
      inviteRoles = redeemed.roles
      inviteCodeId = redeemed.id
    }

    const existing = await usersRepo.findByEmail(input.email, client)
    if (existing) {
      throw new AppError('EMAIL_TAKEN')
    }

    const passwordHash = await password.hash(input.password)
    const created = await usersRepo.create(
      { email: input.email, passwordHash, name: input.name, company: input.company },
      client,
    )

    // An invite's roles always win over DEFAULT_ROLE when both are present
    // — a student who followed a specific cohort link gets exactly that
    // cohort's roles, not a deployment-wide default layered underneath it.
    const roles = inviteRoles ?? (config.defaultRole ? [config.defaultRole] : [])

    if (roles.length > 0) {
      await userRolesRepo.grant(client, {
        userId: created.id,
        roles,
        grantedBy: null,
        inviteCodeId,
      })
      await usersRepo.setActiveRole({ id: created.id, role: pickActiveRole(roles) }, client)
    }

    // Re-read the canonical row (with `roles`/`activeRole` populated by the
    // writes above) rather than assembling the public shape by hand from
    // pieces gathered along the way.
    return usersRepo.findById(created.id, client)
  })

  const authToken = token.sign({ id: finalRow.id })
  return { token: authToken, user: toPublicUser(finalRow) }
}

export async function login({ email, password: plainPassword }) {
  const user = await usersRepo.findByEmail(email)

  // Always run a bcrypt comparison, even when no user was found, against a
  // fixed DUMMY_HASH. This keeps the response time for "no such account"
  // and "wrong password" indistinguishable, so a timing difference can't be
  // used to enumerate which emails are registered.
  const hashToCheck = user ? user.passwordHash : password.DUMMY_HASH
  const isValid = await password.verify(plainPassword, hashToCheck)

  if (!user || !isValid) {
    throw new AppError('INVALID_CREDENTIALS')
  }

  const authToken = token.sign({ id: user.id })
  return { token: authToken, user: toPublicUser(user) }
}

export async function me(userId) {
  const user = await usersRepo.findById(userId)
  if (!user) {
    throw new AppError('USER_NOT_FOUND')
  }
  return toPublicUser(user)
}

// Switches the caller's active work area to one of their already-granted
// roles (PATCH /auth/active-role). Guarded at two independent layers, per
// Qaror C/D in the plan:
//   1. Here — usersRepo.setActiveRole's WHERE EXISTS. 0 rows updated means
//      either the user row doesn't exist at all, or it exists but doesn't
//      have `activeRole` granted; findById disambiguates the two so the
//      right error code goes out (USER_NOT_FOUND vs ROLE_NOT_GRANTED).
//   2. The `users_active_role_fk` composite FK at the database level
//      (migration 003), which would reject the write even if step 1 had a
//      bug — this function doesn't rely on the FK, but the FK is what
//      makes the guarantee absolute rather than "best effort".
export async function setActiveRole(userId, activeRole) {
  const updated = await usersRepo.setActiveRole({ id: userId, role: activeRole })
  if (!updated) {
    const existing = await usersRepo.findById(userId)
    if (!existing) {
      throw new AppError('USER_NOT_FOUND')
    }
    throw new AppError('ROLE_NOT_GRANTED')
  }
  return me(userId)
}

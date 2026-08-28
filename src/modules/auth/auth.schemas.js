// Zod validation schemas for the auth endpoints.
//
// All three schemas are `.strict()`: any unknown key in the request body
// causes validation to fail rather than being silently dropped. This
// matters for `registerSchema` too, not only `loginSchema`/
// `activeRoleSchema`: neither register nor login accepts a `role`/`roles`
// field directly. A brand-new account starts with whatever roles an
// `invite` code (if present) grants, or `config.defaultRole` when the
// deployment has one configured, or no roles at all — never a client-
// supplied value. Only an administrator can grant/change roles afterward,
// via PATCH /admin/users/:id or POST /admin/users/bulk-roles.

import { z } from 'zod'
import { ROLE_KEYS } from '../../constants/roles.js'

export const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().min(1).max(160),
    email: z.string().trim().toLowerCase().email().max(255),
    // 72 is bcrypt's own input-length limit — bytes beyond that are ignored
    // by the underlying algorithm, so anything longer is rejected up front
    // instead of being silently truncated.
    password: z.string().min(8).max(72),
    // Optional invite code. Normalized the same way the DB stores it
    // (upper-cased) so a code pasted in any case still matches. Length
    // bounds mirror invite_codes_code_len in migration 004, so an
    // obviously-malformed value fails validation before ever reaching a
    // query.
    invite: z.string().trim().toUpperCase().min(8).max(64).optional(),
  })
  .strict()

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    // Intentionally NOT `min(8)` here. Login only checks a password against
    // whatever is already stored — a shorter minimum here would leak that
    // "this account predates the 8-character minimum", which is information
    // about the account that a validation error should not reveal.
    password: z.string().min(1).max(72),
  })
  .strict()

// PATCH /auth/active-role body. Deliberately NOT `.nullable()`: a student
// can switch between their already-granted roles but can never clear
// active_role back to "unassigned" themselves — that state only ever
// results from an administrator revoking every role they had (see Qaror C
// in the plan).
export const activeRoleSchema = z
  .object({
    activeRole: z.enum(ROLE_KEYS),
  })
  .strict()

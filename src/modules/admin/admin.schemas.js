// Zod validation schemas for the admin endpoints.
//
// All schemas are `.strict()`: any unknown key in the request/query causes
// validation to fail rather than being silently dropped or ignored.

import { z } from 'zod'
import { ROLE_KEYS } from '../../constants/roles.js'

export const listQuerySchema = z
  .object({
    // The only three recognized filters — anything else is a validation
    // error, never free text that could reach SQL.
    filter: z.enum(['all', 'pending', 'admins']).default('all'),
    search: z.string().trim().max(120).optional(),
    // z.coerce because query-string values arrive as strings ("2", "25").
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

// Shared role-array validator: at most one of each key (deduped), used by
// both the single-user PATCH and the bulk-assign endpoint below.
const rolesArrayBase = z.array(z.enum(ROLE_KEYS)).max(ROLE_KEYS.length)
const rolesArray = rolesArrayBase.transform((roles) => [...new Set(roles)])

// PATCH /admin/users/:id body. `roles`, when present, is the user's
// COMPLETE new role set (replacement semantics, not add/remove) — see
// Qaror C in the plan: AccessModal on the frontend already computes and
// sends the final checked state, and replacement semantics are idempotent
// (submitting the same set twice is a no-op the second time). `activeRole`
// is deliberately not accepted here at all: an admin grants/revokes the
// work-area SET, the student picks which granted one is active (see
// PATCH /auth/active-role) — admin.service.js recomputes activeRole
// automatically only when the edit removes the one currently in use.
export const updateUserSchema = z
  .object({
    roles: rolesArray.optional(),
    isAdmin: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.roles !== undefined || body.isAdmin !== undefined, {
    message: 'Provide at least one of roles or isAdmin',
  })

// POST /admin/users/bulk-roles body. Deliberately has NO `isAdmin` field —
// see Qaror D in the plan: this keeps "an admin selects themselves in a
// bulk action" harmless by construction, since this endpoint can never
// touch admin status at all. `roles` is required and non-empty (unlike the
// optional one above) because there is no "isAdmin-only" bulk action to
// fall back to.
export const bulkRolesSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1).max(200),
    mode: z.enum(['add', 'replace']).default('add'),
    roles: rolesArrayBase.min(1).transform((roles) => [...new Set(roles)]),
  })
  .strict()

// :id route param. Validated as a real UUID up front so a malformed id
// (e.g. "1", "../../etc") fails as a clean VALIDATION_ERROR instead of
// reaching the database and surfacing as a raw PostgreSQL error.
export const userIdSchema = z.string().uuid()

// POST /admin/invites body. `prefix` is the only admin-controlled part of
// the resulting code and is intentionally guessable (see lib/inviteCode.js
// and Qaror B in the plan) — all of the code's actual unpredictability
// comes from the server-generated block appended after it, which this
// schema has no input for at all.
export const inviteCreateSchema = z
  .object({
    label: z.string().trim().max(120).optional(),
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,24}$/, 'Prefix may only contain letters, digits, and hyphens')
      .optional(),
    roles: z
      .array(z.enum(ROLE_KEYS))
      .min(1)
      .max(ROLE_KEYS.length)
      .transform((roles) => [...new Set(roles)]),
    expiresAt: z.coerce.date().optional(),
    maxUses: z.number().int().positive().optional(),
  })
  .strict()

// PATCH /admin/invites/:id body. `roles` and `code` are absent on purpose
// and permanently — see invites.service.js's updateInvite for why they are
// immutable once a code has been created and distributed.
export const inviteUpdateSchema = z
  .object({
    isActive: z.boolean().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
    label: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.isActive !== undefined ||
      body.expiresAt !== undefined ||
      body.maxUses !== undefined ||
      body.label !== undefined,
    { message: 'Provide at least one field to update' },
  )

export const inviteListQuerySchema = z
  .object({
    filter: z.enum(['active', 'inactive', 'all']).default('all'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

export const inviteIdSchema = z.string().uuid()

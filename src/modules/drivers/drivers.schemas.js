// Zod validation schemas for the drivers endpoints.

import { z } from 'zod'

// /drivers is not paginated (see the plan's Endpointlar §"Sahifalash") —
// `limit` is accepted for forward-compatibility but the frontend never
// sends it today, so there's no `page`.
export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict()

// Route param for GET /drivers/:id. Matches migration 005's
// `drivers_id_format` CHECK ('d1', 'd23', ...).
export const driverIdSchema = z.string().regex(/^d[0-9]{1,4}$/)

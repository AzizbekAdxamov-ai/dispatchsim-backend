// Zod validation schemas for the loads endpoints. `.strict()` throughout,
// matching admin.schemas.js — an unknown query/body key is a validation
// error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'

const LOAD_STATUSES = ['ontime', 'warn', 'crit', 'neutral', 'done']

export const listQuerySchema = z
  .object({
    status: z.enum(LOAD_STATUSES).optional(),
    equipmentType: z.enum(EQUIPMENT_KEYS).optional(),
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

// Route param for GET /loads/:id. Matches the `loads_id_format` CHECK in
// migration 007 (4-6 digit reference number) so a malformed id fails as a
// clean VALIDATION_ERROR instead of reaching the database.
export const loadIdSchema = z.string().regex(/^[0-9]{4,6}$/)

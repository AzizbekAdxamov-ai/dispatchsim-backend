// Zod validation schemas for the load board endpoints. `.strict()` throughout
// — an unknown query/body key is a validation error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'

const SORT_OPTIONS = ['posted', 'ratePerMile', 'deadhead', 'pickup']

export const listPostingsSchema = z
  .object({
    equipmentType: z.enum(EQUIPMENT_KEYS).optional(),
    originState: z.string().regex(/^[A-Z]{2}$/).optional(),
    minRatePerMile: z.coerce.number().min(0).max(10).optional(),
    maxDeadheadMi: z.coerce.number().int().min(0).max(5000).optional(),
    sort: z.enum(SORT_OPTIONS).default('posted'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

// Route param for GET /load-board/:id — UUID format (load_postings.id).
export const postingIdSchema = z.string().uuid()

// POST /load-board/:id/book body — driverId is optional.
// When driverId is provided the load status is 'ontime'; when absent it
// is 'neutral' (booked but not yet dispatched).
// truckId is NOT accepted from the client — resolved server-side from
// the driver's truck assignment.
export const bookPostingSchema = z
  .object({
    driverId: z.string().optional(),
  })
  .strict()

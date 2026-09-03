// Zod validation schemas for the load board endpoints. `.strict()` throughout
// — an unknown query/body key is a validation error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'
import { ZONE_KEYS } from '../../constants/zones.js'

const SORT_OPTIONS = ['posted', 'ratePerMile', 'deadhead', 'pickup']

export const listPostingsSchema = z
  .object({
    equipmentType: z.enum(EQUIPMENT_KEYS).optional(),
    originState: z.string().regex(/^[A-Z]{2}$/).optional(),
    fromCity: z.string().min(2).optional(),
    fromState: z.string().regex(/^[A-Z]{2}$/).optional(),
    // Zones are derived from the state code (constants/zones.js) and narrow
    // to `state = ANY(...)`, so a zone and a state filter simply intersect.
    originZone: z.enum(ZONE_KEYS).optional(),
    destinationZone: z.enum(ZONE_KEYS).optional(),
    minRatePerMile: z.coerce.number().min(0).max(10).optional(),
    maxDeadheadMi: z.coerce.number().int().min(0).max(5000).optional(),
    sort: z.enum(SORT_OPTIONS).default('posted'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (v) => (v.fromCity != null) === (v.fromState != null),
    { message: 'fromCity and fromState must both be provided' },
  )

// Query params for GET /load-board/:id. The detail view must measure
// deadhead from the same reference point the list used, otherwise the same
// posting reports two different distances.
export const postingDetailQuerySchema = z
  .object({
    fromCity: z.string().min(2).optional(),
    fromState: z.string().regex(/^[A-Z]{2}$/).optional(),
  })
  .strict()
  .refine((v) => (v.fromCity == null) === (v.fromState == null), {
    message: 'fromCity and fromState must be provided together',
  })

// Route param for GET /load-board/:id — UUID format (load_postings.id).
export const postingIdSchema = z.string().uuid()

// bookPostingSchema is gone with the /book route (2026-09-02). The service
// function bookPosting({ postingId, userId, driverId }) is still there and
// is called from brokerChat.service.acceptRateCon with driverId null —
// dispatch assigns the driver afterwards, against the whole fleet.

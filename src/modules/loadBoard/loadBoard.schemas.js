// Zod validation schemas for the load board endpoints. `.strict()` throughout
// — an unknown query/body key is a validation error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'
import { ZONE_KEYS } from '../../constants/zones.js'

const SORT_OPTIONS = ['posted', 'rate', 'ratePerMile', 'deadhead', 'pickup']

// A state code, or nothing.
const stateCode = z.string().regex(/^[A-Z]{2}$/)

// One equipment type or several, comma separated: "reefer" and
// "reefer,dryVan" are both valid. A dispatcher whose reefer can also run
// dry van asks for both in one search rather than running two.
//
// An unknown key is still a validation error, not a silently dropped
// term -- a filter that quietly ignores half of what it was given shows a
// board the dispatcher did not ask for.
const equipmentTypes = z
  .string()
  .transform((raw) => raw.split(',').map((v) => v.trim()).filter((v) => v !== ''))
  .pipe(z.array(z.enum(EQUIPMENT_KEYS)).min(1))

// The bounds below are guards against nonsense input, not statements
// about trucks: 5000 miles of deadhead, a 100 ft trailer or a 100,000 lb
// load are all impossible, and a request carrying one is a bug or a probe
// rather than a search. The real limits belong to the equipment and to
// 49 CFR 658.17 (80,000 lb gross), and they are not enforced here.
export const listPostingsSchema = z
  .object({
    equipmentType: equipmentTypes.optional(),
    originState: stateCode.optional(),
    destinationState: stateCode.optional(),
    fromCity: z.string().min(2).optional(),
    fromState: stateCode.optional(),
    // Where the search wants to END UP. Gives every row its DH-D -- how
    // far the load's destination is from there -- and, with
    // maxDeadheadDestMi, narrows to the loads that land near it.
    toCity: z.string().min(2).optional(),
    toState: stateCode.optional(),
    // Zones are derived from the state code (constants/zones.js) and narrow
    // to `state = ANY(...)`, so a zone and a state filter simply intersect.
    originZone: z.enum(ZONE_KEYS).optional(),
    destinationZone: z.enum(ZONE_KEYS).optional(),
    minRatePerMile: z.coerce.number().min(0).max(10).optional(),
    maxDeadheadMi: z.coerce.number().int().min(0).max(5000).optional(),
    maxDeadheadDestMi: z.coerce.number().int().min(0).max(5000).optional(),
    maxLengthFt: z.coerce.number().int().min(1).max(100).optional(),
    maxWeightLbs: z.coerce.number().int().min(1).max(100000).optional(),
    // The pickup window, as two instants rather than two dates: the
    // caller's calendar is in the caller's time zone, and a backend that
    // turned "the 26th" into a UTC day would quietly drop five hours of
    // it. The browser sends the exact edges of the days it is showing.
    //
    // `pickupBefore` is EXCLUSIVE and says so in its name -- `pickupTo`
    // with a date in it would read as "up to and including that day"
    // while behaving as "up to midnight where it starts", which is a day
    // of loads missing and nothing on screen to say why.
    pickupFrom: z.coerce.date().optional(),
    pickupBefore: z.coerce.date().optional(),
    sort: z.enum(SORT_OPTIONS).default('posted'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (v) => (v.fromCity != null) === (v.fromState != null),
    { message: 'fromCity and fromState must both be provided' },
  )
  .refine(
    (v) => (v.toCity != null) === (v.toState != null),
    { message: 'toCity and toState must both be provided' },
  )
  .refine(
    (v) => v.pickupFrom == null || v.pickupBefore == null || v.pickupFrom < v.pickupBefore,
    { message: 'pickupFrom must be before pickupBefore' },
  )

// Query params for GET /load-board/:id. The detail view must measure
// deadhead from the same reference point the list used, otherwise the same
// posting reports two different distances.
export const postingDetailQuerySchema = z
  .object({
    fromCity: z.string().min(2).optional(),
    fromState: stateCode.optional(),
    // Same reason for the destination: the row shows a DH-D, and opening
    // it must not change the number.
    toCity: z.string().min(2).optional(),
    toState: stateCode.optional(),
  })
  .strict()
  .refine((v) => (v.fromCity == null) === (v.fromState == null), {
    message: 'fromCity and fromState must be provided together',
  })
  .refine((v) => (v.toCity == null) === (v.toState == null), {
    message: 'toCity and toState must be provided together',
  })

// Route param for GET /load-board/:id — UUID format (load_postings.id).
export const postingIdSchema = z.string().uuid()

// bookPostingSchema is gone with the /book route (2026-09-02). The service
// function bookPosting({ postingId, userId, driverId }) is still there and
// is called from brokerChat.service.acceptRateCon with driverId null —
// dispatch assigns the driver afterwards, against the whole fleet.

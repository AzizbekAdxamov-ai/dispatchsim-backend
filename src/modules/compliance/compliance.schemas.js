import { z } from 'zod'

export const driverLogParamsSchema = z.object({
  driverId: z.string().trim().min(1).max(64),
})

// 0 = today, -1 = yesterday ... back 7 days: the log a driver must be able
// to show at roadside is the current day and the previous 7 (49 CFR
// 395.8(k)(2)).
export const driverLogQuerySchema = z.object({
  day: z.coerce.number().int().min(-7).max(0).default(0),
})

// Date range in simulated days, today included. 8 is the longest window
// any HOS rule looks back over (70 hours in 8 days, 395.3(b)(2)).
export const violationsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(8).default(7),
})

// duty_events.id is a bigserial. Unvalidated, 'abc' would reach PostgreSQL
// and come back as a 500 where a 400 belongs (same reason eventIdSchema
// exists in loads.schemas.js). Bounded at 19 digits, the max for int8.
export const dutyEventIdSchema = z.string().trim().regex(/^[0-9]{1,19}$/, 'id must be a number')


// The review of an unidentified driving record (49 CFR 395.32). The
// annotation IS the review: 4..60 characters, the same window the ELD
// technical standard sets for a comment and 038's
// duty_events_annotation_required / _max CHECKs enforce on the row.
// The schema exists so the same mistake fails as a clean VALIDATION_ERROR
// instead of as a database constraint error the dispatcher cannot act on.
export const reviewAnnotationSchema = z.object({
  annotation: z.string().trim().min(4).max(60),
}).strict()

// Assign also names the driver who actually drove (395.32(d)). The id is
// bounded like dispatchLoadSchema's -- a drivers.id, not free text.
export const reviewAssignSchema = reviewAnnotationSchema.extend({
  driverId: z.string().trim().min(1).max(32),
})

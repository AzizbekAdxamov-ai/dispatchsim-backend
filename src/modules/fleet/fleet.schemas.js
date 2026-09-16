// Zod validation schemas for the /fleet/* endpoints.

import { z } from 'zod'

// Matches migration 006's `trucks_plate_format` CHECK.
export const truckIdSchema = z.string().regex(/^[A-Z]{2}-[0-9]{4}-[A-Z]{2}$/)

// Neither /fleet/trucks nor /fleet/maintenance is paginated (see the
// plan's Endpointlar §"Sahifalash") — `limit` exists only as a
// forward-compatible ceiling the frontend never sends today.
export const trucksQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict()
export const maintenanceQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(200) }).strict()

// POST /fleet/trucks/:id/assign
export const assignDriverSchema = z
  .object({
    driverId: z.string().min(1).max(32),
  })
  .strict()

// POST /fleet/trucks/:id/refuel. `toPct` is the target gauge reading; the
// default fills the tank. Accepted rather than judged: 40% is as valid a
// choice as 100%.
export const refuelSchema = z.object({
  toPct: z.coerce.number().int().min(0).max(100).default(100),
}).strict()

// POST /fleet/maintenance/:id/complete — no body. The id is in the path and
// the cost is the sourced constant; a body would be an invitation to price
// the work by hand.
export const serviceIdSchema = z.string().uuid()

// Zod validation schemas for the loads endpoints. `.strict()` throughout,
// matching admin.schemas.js — an unknown query/body key is a validation
// error, never silently ignored.

import { z } from 'zod'
import { EQUIPMENT_KEYS } from '../../constants/equipment.js'

const LOAD_STATUSES = ['ontime', 'warn', 'crit', 'neutral', 'done']

// POST /loads/:id/dispatch — the truck is not accepted from the client;
// it is whichever truck the driver is assigned to, resolved server-side.
export const dispatchLoadSchema = z
  .object({
    driverId: z.string().min(1).max(32),
  })
  .strict()

// GET /loads/:id/dispatch-check — the same driver id, as a query param.
// Optional: the check screen also renders the load-only view (documents
// lines need a driver, the transit line does not), and an empty string
// from an unset select must read as "no driver picked", not a 400.
export const dispatchCheckQuerySchema = z
  .object({
    driverId: z.string().trim().max(32).optional().default(''),
  })
  .strict()

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

// The chosen option for a road event. Validated as a shape here; whether
// the key is one of THIS event's options is decided in the service, which
// is the only place that knows the event type.
export const resolveEventSchema = z.object({
  optionKey: z.string().trim().min(1).max(40),
})

// load_events.id is a bigserial. Unvalidated, 'abc' reached PostgreSQL and
// came back as a 500 INTERNAL_ERROR where a 400 belongs -- an error the
// student cannot act on, describing a mistake they can see.
export const eventIdSchema = z.object({
  eventId: z.string().trim().regex(/^[0-9]{1,19}$/, 'eventId must be a number'),
})

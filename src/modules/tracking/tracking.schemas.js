// Zod validation schemas for the tracking endpoints. `.strict()`, matching
// loads.schemas.js -- an unknown query key is a validation error, never
// silently ignored.

import { z } from 'zod'

// GET /tracking/loads/:loadId/route -- route param, not a query string.
// Mirrors loads.schemas.js's own loadIdSchema exactly (the `loads_id_format`
// CHECK from migration 007: a 4-6 digit reference number) rather than
// importing it -- every other module here keeps its own id schema local
// (drivers.schemas.js's driverIdSchema, finance.schemas.js's
// invoiceIdSchema, ...), so a param shape belongs to the module whose
// route uses it, not to whichever module happens to own the underlying
// table.
export const loadRouteParamsSchema = z
  .object({
    loadId: z.string().regex(/^[0-9]{4,6}$/),
  })
  .strict()

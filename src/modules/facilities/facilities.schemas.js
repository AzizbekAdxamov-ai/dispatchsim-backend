// Zod validation schemas for /facilities. `.strict()`, matching
// tracking.schemas.js -- an unknown query key is a validation error,
// never silently ignored.

import { z } from 'zod'

export const FACILITY_KIND_KEYS = ['fuel', 'truck_stop', 'rest_area', 'repair']

// The CONUS box facilities_conus (035) and test/tracking.test.js's own
// CONUS constant both enforce -- the SAME four numbers, not a third
// guess. haversineMi's diagonal across this exact box is ~3597mi (see
// scripts/facilities.test.js), so 3600 is a real ceiling on how far apart
// two CONUS points can ever be, not a round number picked for looking
// generous.
const MAX_RADIUS_MI = 3600

// GET /facilities?kinds=fuel,truck_stop&near=lat,lon&radiusMi=50
//
// kinds: comma-separated, each one a real FACILITY_KIND_KEYS value --
// piped through z.enum so an unknown kind is a shape error here, not a
// silent "matches nothing" once it reaches SQL's = ANY($3::text[]).
// near: "lat,lon" -- one query param rather than two (nearLat/nearLon) to
// mirror routing's own `originCity,originState` pairing style; parsed
// into { lat, lon } for the controller, not resolved against CITIES here
// -- unlike routing.schemas.js's routeQuerySchema this endpoint takes a
// raw point, not a named city, so there is no closed set to check against
// (see facilities.service.js's nearestTo for why: a facility itself sits
// off-city, on a road).
export const listQuerySchema = z
  .object({
    kinds: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
      .pipe(z.array(z.enum(FACILITY_KIND_KEYS)).min(1))
      .optional(),
    near: z
      .string()
      .trim()
      .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, 'near must be "lat,lon"')
      .transform((s) => {
        const [lat, lon] = s.split(',').map(Number)
        return { lat, lon }
      })
      .optional(),
    radiusMi: z.coerce.number().positive().max(MAX_RADIUS_MI).optional(),
  })
  .strict()

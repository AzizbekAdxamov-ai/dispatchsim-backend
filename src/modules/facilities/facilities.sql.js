// SQL for `facilities` (migration 035). sql-check PREPAREs every export
// here against the real schema, the same pattern as tracking/fleet/
// routing -- see scripts/sql-check.js's own module loop.
//
// facilities.repository.js imports and runs THESE strings; nothing here
// is a pretty-printed copy of what actually ships.
//
// Proximity is a plain haversine, computed in SQL rather than in
// facilities.repository.js's caller -- the same formula
// scripts/seed/cities.js's haversineMi() uses in JS (EARTH_RADIUS_MI =
// 3958.8), deliberately WITHOUT cities.js's own 1.18 road-vs-great-circle
// multiplier: that multiplier estimates ROAD miles between two cities for
// a load's distance_mi, not "how far is this pump from where I'm
// standing", which is what a dispatcher actually wants here. Written as a
// WITH ... AS "distanceMi" CTE (the same pattern finance.repository.js's
// INVOICE_CTE uses) so the outer query can filter/order on the alias --
// Postgres does not allow a SELECT-list alias inside its own WHERE
// clause, only in a later query over it.
const HAVERSINE_MI = `
    3958.8 * 2 * asin(least(1.0, sqrt(
      sin(radians(lat - $1::numeric) / 2) ^ 2
      + cos(radians($1::numeric)) * cos(radians(lat))
        * sin(radians(lon - $2::numeric) / 2) ^ 2
    )))`

const SCORED_CTE = `
  WITH scored AS (
    SELECT id, kind, name, lat, lon,
           near_city AS "nearCity", near_state AS "nearState",
           fuel_price_cents AS "fuelPriceCents", amenities,
           ${HAVERSINE_MI} AS "distanceMi"
      FROM facilities
     WHERE ($3::text[] IS NULL OR kind = ANY($3::text[]))
  )`

// listNear(lat, lon, radiusMi, kinds): $1 lat, $2 lon, $3 kinds (text[]
// or NULL for "any kind"), $4 radiusMi.
export const LIST_NEAR_SQL = `${SCORED_CTE}
  SELECT * FROM scored
   WHERE "distanceMi" <= $4::numeric
   ORDER BY "distanceMi" ASC`

// nearestTo(lat, lon, kinds): $1 lat, $2 lon, $3 kinds. No radius --
// "nearest" always answers something as long as one facility of an
// allowed kind exists anywhere, the same way routing.service.js's
// resolveCity never bounds how far a city may be.
export const NEAREST_ONE_SQL = `${SCORED_CTE}
  SELECT * FROM scored
   ORDER BY "distanceMi" ASC
   LIMIT 1`

// listAll(): every facility, no filter -- read by
// scripts/generate-facilities.js and facilities.service.js's alongRoute()
// as the full "what already exists" set placeAlongRoute dedupes new
// candidates against (scripts/seed/facilities.js's own header explains
// why that set has to span every route, not just the one being placed).
export const LIST_ALL_SQL = `
  SELECT id, kind, name, lat, lon,
         near_city AS "nearCity", near_state AS "nearState",
         fuel_price_cents AS "fuelPriceCents", amenities
    FROM facilities
   ORDER BY near_state, near_city, kind, name`

// insertMany's per-row statement. ON CONFLICT DO NOTHING against
// PRIMARY KEY(id) -- id is deterministic (facilities.js's facilityId()),
// so a re-run over the same routes reproduces the same id and this is a
// no-op the second time, not a duplicate-key error (the same idempotency
// pattern routing.sql.js's INSERT_ROUTE_SQL already uses for lane_routes).
export const INSERT_FACILITY_SQL = `
  INSERT INTO facilities (
    id, kind, name, lat, lon, near_city, near_state, fuel_price_cents, amenities
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (id) DO NOTHING
  RETURNING id`

// SQL for lane_routes (migration 034). sql-check PREPAREs every export
// here against the real schema -- the same pattern as fleet.sql.js and
// payroll.sql.js -- so a typo only reached the first time a new lane gets
// searched fails here instead of on a student's screen.
//
// routing.repository.js imports and runs THESE strings; nothing here is a
// pretty-printed copy of what actually ships.

export const GET_ROUTES_SQL = `
  SELECT alternative_index AS "alternativeIndex", geometry,
         distance_mi AS "distanceMi", duration_min AS "durationMin",
         road_refs AS "roadRefs"
    FROM lane_routes
   WHERE origin_city = $1 AND origin_state = $2
     AND destination_city = $3 AND destination_state = $4
   ORDER BY alternative_index ASC`

// One row per call; routing.repository.js's saveRoutes() loops it once per
// alternative. ON CONFLICT DO NOTHING rather than DO UPDATE: two
// concurrent requests for a lane no one has searched yet both fetch from
// OSRM (harmless -- OSRM is read-only and idempotent) and whichever INSERT
// lands second is a no-op, not a race that overwrites a row with an
// equivalent one.
export const INSERT_ROUTE_SQL = `
  INSERT INTO lane_routes (
    origin_city, origin_state, destination_city, destination_state,
    alternative_index, geometry, distance_mi, duration_min, road_refs
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (origin_city, origin_state, destination_city, destination_state, alternative_index)
  DO NOTHING
  RETURNING id`

// Same one row per alternative as INSERT_ROUTE_SQL, but DO UPDATE instead
// of DO NOTHING -- used ONLY by scripts/warm-routes.js's --refresh flag
// (routing.service.js's refreshRoutes(), never routesFor()'s normal
// cache-read-through path). Exists to replace rows fetched back when
// osrm.js requested overview=simplified (coarse, cuts across fields at
// city zoom -- see osrm.js's own header) with the overview=full geometry
// it asks for now, on an operator's explicit request -- INSERT_ROUTE_SQL's
// own DO NOTHING stays correct for the live path (two concurrent
// first-time fetches of the same never-before-searched lane), this
// statement is for the DIFFERENT case of deliberately re-fetching a lane
// that is already cached.
export const UPSERT_ROUTE_SQL = `
  INSERT INTO lane_routes (
    origin_city, origin_state, destination_city, destination_state,
    alternative_index, geometry, distance_mi, duration_min, road_refs
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT ON CONSTRAINT lane_routes_unique
  DO UPDATE SET
    geometry = EXCLUDED.geometry,
    distance_mi = EXCLUDED.distance_mi,
    duration_min = EXCLUDED.duration_min,
    road_refs = EXCLUDED.road_refs,
    fetched_at = now()
  RETURNING id`

// Every cached route, every lane, every alternative -- unlike
// GET_ROUTES_SQL (one lane) this is read by scripts/generate-facilities.js
// to walk the whole road network the app has ever fetched from OSRM, not
// by anything in the live request path (routing.service.js never asks for
// more than one lane at a time).
export const LIST_ALL_ROUTES_SQL = `
  SELECT id, origin_city AS "originCity", origin_state AS "originState",
         destination_city AS "destinationCity", destination_state AS "destinationState",
         alternative_index AS "alternativeIndex", geometry,
         distance_mi AS "distanceMi"
    FROM lane_routes
   ORDER BY id`

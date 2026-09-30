// The tracking board's data: every load on the road, with where it is.
//
// One endpoint, read-only, computed on read. A `positions` table would be
// a second copy of a fact the clock knows; nothing here writes anything.

import { query } from '../../db/pool.js'

// In-transit loads with the fields the position math and the page both
// need. Uses the raw loads columns rather than ROW_SELECT's lateral joins:
// a tracking board wants many small rows, not 200 enriched ones. `current`
// comes back as the jsonb driver/truck summaries the board chips render.
//
// Statuses mirror the loads page's Active tab: 'ontime', 'warn' and 'crit'
// are all on the road -- a late truck is a truck, and the page states
// lateness as a field instead of filtering it out.
export const IN_TRANSIT_BOARD_SQL = `
  SELECT l.id, l.status,
         l.origin_city AS "originCity", l.origin_state AS "originState",
         l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
         l.distance_mi AS "distanceMi", l.rate_usd AS "rateUsd",
         l.dispatched_at AS "dispatchedAt", l.eta_at AS "etaAt",
         l.promised_eta_at AS "promisedEtaAt",
         -- What stop planning concluded (037): its status and the HOS
         -- facts behind the ETA, shown on the board instead of logged.
         l.stop_plan_status AS "stopPlanStatus",
         l.stop_plan_facts AS "stopPlanFacts",
         -- The driver's HOS columns, written by the tick's syncDriverHos
         -- from duty_events (037) -- live, not the old 660 constant.
         (SELECT jsonb_build_object(
                   'id', d.id, 'name', d.name,
                   'dutyStatus', d.duty_status,
                   'hosRemainingMin', d.hos_remaining_min,
                   'hoursTodayMin', d.hours_today_min,
                   'hoursWeekMin', d.hours_week_min)
            FROM drivers d WHERE d.id = l.driver_id) AS driver,
         (SELECT jsonb_build_object('id', t.id, 'make', t.make, 'model', t.model)
            FROM trucks t WHERE t.id = l.truck_id) AS truck,
         -- The moment the load's open event (if any) started, not just
         -- whether one exists. position.js needs the timestamp to freeze
         -- the marker where the truck actually stopped -- a plain boolean
         -- told the page "stopped" while still sliding the dot forward.
         -- A bare subselect (not EXISTS/an aggregate) is safe here: the
         -- partial unique index load_events_one_open guarantees at most
         -- one unresolved row per load.
         (SELECT e.occurred_at FROM load_events e
           WHERE e.load_id = l.id AND e.resolved_at IS NULL) AS "eventOpenedAt",
         -- The lane's own alternative-0 route (034), if one has ever been
         -- fetched for this exact origin/destination pair. LEFT JOIN, not a
         -- subselect returning a scalar: lane_routes.geometry is the ONLY
         -- column pulled off it, and a plain join reads clearer than a
         -- correlated subquery for a single-row lookup keyed by the
         -- lane_routes_unique index's own leftmost columns (which is why
         -- there's no need for a second index here -- see 034). Which
         -- alternative to use for a load is not a stored fact yet (that's
         -- the next task, per the plan) -- 0 (OSRM's own primary route) is
         -- the only choice today.
         --
         -- This is the FULL geometry osrm.js now fetches (overview=full --
         -- see its own header), not a simplified copy -- position.js's
         -- pointAlongPath() needs every point to place the marker
         -- accurately. tracking.service.js's shapeBoard() is what turns
         -- THIS full column into the lightweight, simplified copy the
         -- board response actually ships (BOARD_TOLERANCE_MI there) --
         -- that simplification happens after this query returns, never
         -- in SQL, so it stays testable as a pure function.
         lr.geometry AS "routeGeometry",
         -- The stop the truck is AT right now, if any -- arrived_at has
         -- passed and departed_at has not. position.js freezes the marker
         -- at this facility's own lat/lon while it's non-null (see its own
         -- header on why eventOpenedAt still wins when both are set: an
         -- open event is an unplanned real-world stop, this is a planned
         -- one, and the emergency is the more truthful "where is it"
         -- answer). ORDER BY departed_at DESC LIMIT 1: a merged fuel+rest
         -- stop (stopPlan.js's mergeNearbyStops) is two separate rows at
         -- the same facility with two different windows -- the one that
         -- ends LATER is the one still governing when the truck actually
         -- leaves, so that's the one the board should show as "current".
         (SELECT jsonb_build_object(
             'facilityName', f.name, 'city', f.near_city, 'state', f.near_state,
             'reason', sv.reason, 'arrivedAt', sv.arrived_at, 'departedAt', sv.departed_at,
             'gallons', sv.gallons, 'costUsd', sv.cost_usd,
             'lat', f.lat, 'lon', f.lon
           )
            FROM stop_visits sv
            JOIN facilities f ON f.id = sv.facility_id
           WHERE sv.load_id = l.id AND sv.arrived_at <= now() AND now() < sv.departed_at
           ORDER BY sv.departed_at DESC
           LIMIT 1) AS "currentStop",
         -- The load's FULL planned stop list -- embedded here rather than
         -- a separate GET /tracking/:loadId/stops endpoint, for the same
         -- reason routeGeometry (a whole polyline, heavier than this) is
         -- already embedded instead of fetched per load: the board is one
         -- query for "everything this page needs" (driver/truck above are
         -- the same choice), and a handful of stop rows per load is not
         -- where this query's cost goes. 'settled' says whether the tick
         -- has already paid for a fuel stop -- false for 'rest' rows,
         -- which are never settled (stop_visits_settled_only_fuel, 036).
         (SELECT jsonb_agg(jsonb_build_object(
             'facilityName', f.name, 'city', f.near_city, 'state', f.near_state,
             'reason', sv.reason, 'routeOffsetMi', sv.route_offset_mi,
             'arrivedAt', sv.arrived_at, 'departedAt', sv.departed_at,
             'gallons', sv.gallons, 'costUsd', sv.cost_usd,
             'settled', sv.settled_at IS NOT NULL
           ) ORDER BY sv.route_offset_mi)
            FROM stop_visits sv
            JOIN facilities f ON f.id = sv.facility_id
           WHERE sv.load_id = l.id) AS "plannedStops"
    FROM loads l
    LEFT JOIN lane_routes lr
      ON lr.origin_city = l.origin_city AND lr.origin_state = l.origin_state
     AND lr.destination_city = l.destination_city AND lr.destination_state = l.destination_state
     AND lr.alternative_index = 0
   WHERE l.delivered_at IS NULL
     AND l.dispatched_at IS NOT NULL
     AND l.eta_at IS NOT NULL
     AND l.status IN ('ontime', 'warn', 'crit')
   ORDER BY l.eta_at ASC`

export async function inTransitBoard() {
  const result = await query(IN_TRANSIT_BOARD_SQL)
  return result.rows
}

// Open postings for the map's lane-search panel -- the same listing the
// load board serves, read here with the columns the panel needs (both
// coordinate pairs so the map can draw each recommendation's own lane
// without a second lookup). Same visibility rule as the board itself:
// open + posted + not expired. No deadhead lateral here -- the panel's
// deadhead is anchored to the SEARCHED origin, not the nearest driver,
// and it is computed in laneSearch.js where the anchor is known.
export const OPEN_POSTINGS_SQL = `
  SELECT p.id, p.origin_city AS "originCity", p.origin_state AS "originState",
         p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
         p.origin_lat AS "originLat", p.origin_lon AS "originLon",
         p.destination_lat AS "destinationLat", p.destination_lon AS "destinationLon",
         p.broker, p.commodity,
         CASE WHEN p.rate_hidden THEN NULL ELSE p.rate_usd END AS "rateUsd",
         p.rate_hidden AS "rateHidden",
         p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
         p.equipment_type AS "equipmentType",
         p.pickup_at AS "pickupAt", p.expires_at AS "expiresAt"
    FROM load_postings p
   WHERE p.status = 'open'
     AND p.posted_at <= now()
     AND p.expires_at > now()
   ORDER BY p.posted_at DESC
   LIMIT 500`

export async function openPostings() {
  const result = await query(OPEN_POSTINGS_SQL)
  return result.rows
}

// The trucks with nothing on them. A fresh start (Azizbek, 2026-09-30:
// one driver, one truck) leaves the board with ZERO loads, and a board
// built from loads alone would draw an empty map while a real truck sat
// in a yard in Seattle. So the board also names the trucks that are not
// running a load: the position shown is the DRIVER's own last-known spot
// (drivers.current_lat/lon -- the trucks table keeps no coordinates, and
// inventing a lat/lon for a parked unit would be a fact this schema does
// not have). A truck with no driver, or a driver the tick has never
// placed, carries no coordinates -- it is reported so the count is
// honest, and the map skips it rather than guessing.
//
// Both NOT EXISTS arms are the same "has an undelivered load" shape
// getAvailabilityCounts() (drivers.repository) already uses for the
// dashboard tile -- one definition of "idle" across the app, not two.
export const IDLE_TRUCKS_SQL = `
  SELECT t.id,
         t.make, t.model, t.year,
         t.location_city AS "locationCity", t.location_state AS "locationState",
         (SELECT jsonb_build_object(
                   'id', d.id, 'name', d.name,
                   'dutyStatus', d.duty_status,
                   'hosRemainingMin', d.hos_remaining_min,
                   'currentCity', d.current_city,
                   'currentState', d.current_state,
                   'lat', d.current_lat, 'lon', d.current_lon)
            FROM drivers d WHERE d.id = t.driver_id) AS driver
    FROM trucks t
   WHERE NOT EXISTS (
           SELECT 1 FROM loads l
            WHERE l.truck_id = t.id AND l.status <> 'done'
         )
     AND NOT EXISTS (
           SELECT 1 FROM loads l
            WHERE l.driver_id = t.driver_id AND l.status <> 'done'
         )
   ORDER BY t.id`

export async function idleTrucks() {
  const result = await query(IDLE_TRUCKS_SQL)
  return result.rows
}

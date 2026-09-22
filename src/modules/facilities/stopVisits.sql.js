// SQL for `stop_visits` (migration 036). sql-check PREPAREs every export
// here against the real schema, the same pattern as facilities.sql.js/
// routing.sql.js -- see scripts/sql-check.js's own module loop.
//
// stopVisits.repository.js imports and runs THESE strings; nothing here
// is a pretty-printed copy of what actually ships.

// insertOne's statement. ON CONFLICT DO NOTHING against stop_visits_unique
// (load_id, route_offset_mi, reason) -- a re-dispatch of the same load (it
// cannot happen twice for a load already 'ontime', but cancelDispatch +
// re-dispatch is a real path) reproduces the same planned stops and this
// is a no-op the second time, the same idempotency pattern facilities.sql.js's
// INSERT_FACILITY_SQL already uses.
export const INSERT_STOP_VISIT_SQL = `
  INSERT INTO stop_visits (
    load_id, truck_id, driver_id, facility_id, reason, route_offset_mi,
    arrived_at, departed_at, gallons, cost_usd
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (load_id, route_offset_mi, reason) DO NOTHING
  RETURNING id`

// The tick's claim: unsettled fuel visits that have already arrived.
// FOR UPDATE SKIP LOCKED, same as loads.repository.js's claimArrivedLoads/
// claimDueInvoices -- two ticks overlapping never settle the same visit
// twice; the second simply does not see it.
export const CLAIM_ARRIVED_FUEL_VISITS_SQL = `
  SELECT id, load_id AS "loadId", truck_id AS "truckId", driver_id AS "driverId",
         facility_id AS "facilityId", gallons, cost_usd AS "costUsd"
    FROM stop_visits
   WHERE reason = 'fuel' AND settled_at IS NULL AND arrived_at <= now()
   ORDER BY arrived_at
   LIMIT $1
   FOR UPDATE SKIP LOCKED`

// Conditional on settled_at IS NULL -- same idiom as loads.repository.js's
// markDelivered/markInvoicePaid: a tick that somehow reached this row
// twice in two overlapping transactions (SKIP LOCKED already prevents it,
// this is the second line of defense) settles it once.
export const MARK_SETTLED_SQL = `
  UPDATE stop_visits SET settled_at = now()
   WHERE id = $1 AND settled_at IS NULL
   RETURNING id`

// The "current stop" and "full plan" reads live in tracking.repository.js
// instead of here, joined straight into the board's one query -- the same
// choice that query already made for lane_routes (routing.repository.js's
// own table): a board row needs many small facts assembled at read time,
// not a second round trip per load. This file stays the writer's file --
// insert the plan, claim it, settle it -- since stop_visits.repository.js
// (the only file that WRITES this table) owns that half.

// A road event re-plans the rest of the run: stops planned at or after
// the event that have not been paid for are removed (the re-plan writes
// the new ones). A settled stop is money that already left -- untouched.
export const DELETE_UNSETTLED_FROM_SQL = `
  DELETE FROM stop_visits
   WHERE load_id = $1 AND arrived_at >= $2 AND settled_at IS NULL
  RETURNING id`

// Fuel stops of this load that arrived before $2 -- whether the tank was
// refilled before the event.
export const FUEL_BEFORE_SQL = `
  SELECT count(*)::int AS n
    FROM stop_visits
   WHERE load_id = $1 AND reason = 'fuel' AND arrived_at < $2`

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
         (SELECT jsonb_build_object('id', d.id, 'name', d.name)
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
           WHERE e.load_id = l.id AND e.resolved_at IS NULL) AS "eventOpenedAt"
    FROM loads l
   WHERE l.delivered_at IS NULL
     AND l.dispatched_at IS NOT NULL
     AND l.eta_at IS NOT NULL
     AND l.status IN ('ontime', 'warn', 'crit')
   ORDER BY l.eta_at ASC`

export async function inTransitBoard() {
  const result = await query(IN_TRANSIT_BOARD_SQL)
  return result.rows
}

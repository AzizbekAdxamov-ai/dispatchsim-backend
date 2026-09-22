// SQL for road events. sql-check PREPAREs every export here.

// Loads that could meet something: in transit, not delivered, and not
// already stopped by an unresolved event. Elapsed fraction comes back with
// them so the caller can say where the driver is without inventing a
// position -- drivers.current_location has no runtime writer.
//
// serviceOverdue: the truck pulling this load has crossed a service interval
// nobody has completed (status <> 'done', odometer at or past the due
// mileage). A truck in that state is taken out of the normal event mix and
// always meets a breakdown -- see rollEvents. NOT EXISTS so one overdue
// record is read once per load, not once per row of the join.
export const IN_TRANSIT_LOADS_SQL = `
  SELECT l.id, l.driver_id AS "driverId", l.distance_mi AS "distanceMi",
         l.origin_city AS "originCity", l.origin_state AS "originState",
         l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
         l.dispatched_at AS "dispatchedAt", l.promised_eta_at AS "promisedEtaAt",
         EXISTS (
           SELECT 1
             FROM trucks t
             JOIN maintenance_records m ON m.truck_id = t.id
            WHERE t.id = l.truck_id
              AND m.status <> 'done'
              AND m.due_mileage IS NOT NULL
              AND t.odometer_mi >= m.due_mileage
         ) AS "serviceOverdue",
         EXTRACT(EPOCH FROM (now() - l.dispatched_at))
           / NULLIF(EXTRACT(EPOCH FROM (l.eta_at - l.dispatched_at)), 0) AS "elapsedFraction",
         -- How much of the run has passed SINCE THIS LOAD WAS LAST ROLLED.
         -- The chance of meeting something is taken from this fraction
         -- rather than from a tick count, so the rate over a whole run is
         -- the same whether the scheduler fires every 30 seconds, every 60,
         -- or not at all for an hour after a deploy. event_checked_at is
         -- NULL until the first roll; dispatch time is the right starting
         -- point for that first stretch.
         EXTRACT(EPOCH FROM (now() - coalesce(l.event_checked_at, l.dispatched_at)))
           / NULLIF(EXTRACT(EPOCH FROM (l.eta_at - l.dispatched_at)), 0) AS "sinceCheckFraction",
         EXTRACT(EPOCH FROM (l.eta_at - l.dispatched_at)) AS "transitSeconds"
    FROM loads l
   WHERE l.delivered_at IS NULL
     AND l.dispatched_at IS NOT NULL
     AND l.eta_at IS NOT NULL
     AND l.status IN ('ontime', 'warn', 'crit')
     AND NOT EXISTS (
           SELECT 1 FROM load_events e
            WHERE e.load_id = l.id AND e.resolved_at IS NULL
         )
   ORDER BY l.dispatched_at
   LIMIT $1`

// Mark a load as rolled, whatever the outcome. Written for every load the
// tick looked at -- not only the ones that met something -- or the elapsed
// fraction would keep growing and a quiet load would eventually meet
// something with certainty.
export const MARK_CHECKED_SQL = `
  UPDATE loads SET event_checked_at = now() WHERE id = ANY($1::text[])`

// Raise an event. ON CONFLICT against load_events_one_open makes a second
// roll on the same load a no-op rather than a queue of blizzards -- the
// tick fires every 30 seconds and a load left alone would otherwise
// collect a stack instead of presenting a decision.
export const RAISE_EVENT_SQL = `
  INSERT INTO load_events (load_id, event_type, place)
  VALUES ($1, $2, $3)
  ON CONFLICT (load_id) WHERE resolved_at IS NULL DO NOTHING
  RETURNING id, load_id AS "loadId", event_type AS "eventType", place,
            occurred_at AS "occurredAt"`

// The open event on one load, for the dispatcher's screen.
export const OPEN_EVENT_SQL = `
  SELECT id, load_id AS "loadId", event_type AS "eventType", place,
         occurred_at AS "occurredAt"
    FROM load_events
   WHERE load_id = $1 AND resolved_at IS NULL`

// Locked for resolution. FOR UPDATE so two clicks on the same option
// cannot both apply it; the conditional UPDATE below is the other half.
export const CLAIM_EVENT_SQL = `
  SELECT e.id, e.load_id AS "loadId", e.event_type AS "eventType", e.place,
         e.occurred_at AS "occurredAt",
         l.eta_at AS "etaAt", l.accessorials
    FROM load_events e
    JOIN loads l ON l.id = e.load_id
   WHERE e.id = $1 AND e.resolved_at IS NULL
   FOR UPDATE OF e`

// Resolve. Zero rows back means somebody else already did, and nothing --
// no ETA change, no charge -- should follow.
export const RESOLVE_EVENT_SQL = `
  UPDATE load_events
     SET resolved_at = now(), option_key = $2, hours_added = $3,
         extra_miles = $4, cost_usd = $5, accessorial_usd = $6
   WHERE id = $1 AND resolved_at IS NULL
   RETURNING id, load_id AS "loadId", option_key AS "optionKey",
             resolved_at AS "resolvedAt",
             hours_added AS "hoursAdded", cost_usd AS "costUsd",
             accessorial_usd AS "accessorialUsd"`

// Push the ETA back by the hours the chosen option cost. The promise is
// NOT moved: the promise is what the broker was told, and an event does
// not renegotiate it. That gap is what makes the load late.
export const EXTEND_ETA_SQL = `
  UPDATE loads
     SET eta_at = eta_at + ($2::int * interval '1 second')
   WHERE id = $1 AND delivered_at IS NULL AND dispatched_at IS NOT NULL
   RETURNING id, eta_at AS "etaAt", promised_eta_at AS "promisedEtaAt"`

// Bill the wait. accessorials is jsonb and is already what the invoice
// sums, so a billed detention reaches the broker's payment without a
// second place to keep it.
export const ADD_ACCESSORIAL_SQL = `
  UPDATE loads
     SET accessorials = accessorials || jsonb_build_array(
           jsonb_build_object('label', $2::text, 'amountUsd', $3::int)
         )
   WHERE id = $1 AND delivered_at IS NULL AND dispatched_at IS NOT NULL
   RETURNING id, accessorials`

// Every event on a load, for its detail page.
export const LIST_FOR_LOAD_SQL = `
  SELECT id, event_type AS "eventType", place, occurred_at AS "occurredAt",
         resolved_at AS "resolvedAt", option_key AS "optionKey",
         hours_added AS "hoursAdded", extra_miles AS "extraMiles",
         cost_usd AS "costUsd", accessorial_usd AS "accessorialUsd"
    FROM load_events
   WHERE load_id = $1
   ORDER BY occurred_at DESC`

// Close every open event on a load that is no longer running.
//
// cancelDispatch used to leave them open. The loads row survives a cancel,
// so the ON DELETE CASCADE never fires, and the orphan then blocked
// claimArrivedLoads forever: the load could be re-dispatched, would never
// arrive, would slide to 'crit', and nothing anywhere logged a reason. The
// row is closed rather than deleted so the history of the run survives.
export const CLOSE_EVENTS_FOR_LOAD_SQL = `
  UPDATE load_events
     SET resolved_at = now(), option_key = 'cancelled',
         hours_added = 0, extra_miles = 0, cost_usd = 0, accessorial_usd = 0
   WHERE load_id = $1 AND resolved_at IS NULL
   RETURNING id`

// Open events across the board, for the alerts panel.
export const OPEN_EVENTS_SQL = `
  SELECT e.id, e.load_id AS "loadId", e.event_type AS "eventType", e.place,
         e.occurred_at AS "occurredAt",
         l.broker, l.rate_usd AS "rateUsd",
         d.name AS "driverName"
    FROM load_events e
    JOIN loads l ON l.id = e.load_id
    LEFT JOIN drivers d ON d.id = l.driver_id
   WHERE e.resolved_at IS NULL
   ORDER BY e.occurred_at`

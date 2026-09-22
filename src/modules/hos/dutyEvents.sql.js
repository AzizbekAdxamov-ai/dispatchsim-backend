// SQL for `duty_events` (migration 037) -- the ELD log. sql-check
// PREPAREs every export here against the real schema, same pattern as
// stopVisits.sql.js. dutyEvents.repository.js runs THESE strings.

// One planned (or recorded) duty status. ON CONFLICT against
// duty_events_one_active_start (driver_id, started_at) WHERE active: a
// re-run of the same plan is a no-op, not a second copy of the log.
export const INSERT_DUTY_EVENT_SQL = `
  INSERT INTO duty_events (
    driver_id, load_id, truck_id, status, started_at, ended_at,
    route_offset_mi, facility_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (driver_id, started_at) WHERE record_status = 'active' DO NOTHING
  RETURNING id`

// A driver's active log since $2 -- enough history for every HOS clock
// (the 8-day 70-hour window is the longest). Events that have not started
// yet are included; hosClock.js clips every sum at "now".
export const RECENT_FOR_DRIVER_SQL = `
  SELECT status, started_at AS "startedAt", ended_at AS "endedAt"
    FROM duty_events
   WHERE driver_id = $1 AND record_status = 'active' AND ended_at > $2
   ORDER BY started_at`

// The same, for every working driver at once -- the tick's sync.
// 'off' drivers (HR: not working for the company) are left alone.
export const RECENT_FOR_WORKING_DRIVERS_SQL = `
  SELECT d.id AS "driverId",
         COALESCE(
           json_agg(json_build_object(
             'status', e.status, 'startedAt', e.started_at, 'endedAt', e.ended_at
           ) ORDER BY e.started_at) FILTER (WHERE e.id IS NOT NULL),
           '[]'::json
         ) AS events
    FROM drivers d
    LEFT JOIN duty_events e
      ON e.driver_id = d.id AND e.record_status = 'active' AND e.ended_at > $1
   WHERE d.duty_status <> 'off'
   GROUP BY d.id`

// The four derived columns. duty_status only when an event covers now
// ($2 NULL keeps the column -- a driver between loads stays 'resting').
export const UPDATE_DRIVER_HOS_SQL = `
  UPDATE drivers
     SET duty_status       = COALESCE($2, duty_status),
         hos_remaining_min = $3,
         hours_today_min   = $4,
         hours_week_min    = $5
   WHERE id = $1 AND duty_status <> 'off'
  RETURNING id`

// Cancelling a dispatch: the part of the plan that has not happened yet
// is removed (it was never recorded, so removing it is not an ELD edit),
// and the status in progress right now ends now.
export const DELETE_FUTURE_FOR_LOAD_SQL = `
  DELETE FROM duty_events
   WHERE load_id = $1 AND origin = 'automatic' AND started_at > now()
  RETURNING id`

export const END_CURRENT_FOR_LOAD_SQL = `
  UPDATE duty_events
     SET ended_at = now()
   WHERE load_id = $1 AND origin = 'automatic' AND record_status = 'active'
     AND started_at <= now() AND ended_at > now()
  RETURNING id`

// One run's automatic, active log -- the plan written at dispatch.
export const FOR_LOAD_SQL = `
  SELECT status, started_at AS "startedAt", ended_at AS "endedAt"
    FROM duty_events
   WHERE load_id = $1 AND origin = 'automatic' AND record_status = 'active'
   ORDER BY started_at`

// A road event at $2 replaces the plan from that moment on: what was
// planned to start at or after it is removed, the status running at it
// ends at it. Only the automatic plan rows of this load are touched.
export const DELETE_FROM_AT_FOR_LOAD_SQL = `
  DELETE FROM duty_events
   WHERE load_id = $1 AND origin = 'automatic' AND started_at >= $2
  RETURNING id`

export const END_AT_FOR_LOAD_SQL = `
  UPDATE duty_events
     SET ended_at = $2
   WHERE load_id = $1 AND origin = 'automatic' AND record_status = 'active'
     AND started_at < $2 AND ended_at > $2
  RETURNING id`

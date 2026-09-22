// SQL for /compliance (Driver HOS). sql-check PREPAREs every export here.
//
// $n "realSecPerSimDay" is simClock.js's REAL_SEC_PER_SIM_DAY, passed in
// rather than typed as 120 -- the same number sim_day() (033) is built on.

// Every working driver (duty_status <> 'off' -- HR's "not working for the
// company"), their truck, and their active duty log since $1. One row per
// driver; events as a JSON array. The server's now() and the start of the
// next simulated day come back on every row so the service measures
// against the database's clock, not the app server's.
export const DRIVERS_HOS_SQL = `
  WITH clock AS (
    SELECT now() AS now,
           sim_epoch()
             + (floor(EXTRACT(EPOCH FROM (now() - sim_epoch())) / $2::numeric) + 1)
               * ($2::numeric * interval '1 second') AS next_day_start
  )
  SELECT d.id AS "driverId", d.name AS "driverName",
         t.id AS "truckId", t.make AS "truckMake", t.model AS "truckModel",
         clock.now AS "now", clock.next_day_start AS "nextDayStart",
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'status', e.status, 'startedAt', e.started_at, 'endedAt', e.ended_at
                   ) ORDER BY e.started_at)
              FROM duty_events e
             WHERE e.driver_id = d.id AND e.record_status = 'active' AND e.ended_at > $1),
           '[]'::json
         ) AS events
    FROM drivers d
    CROSS JOIN clock
    LEFT JOIN trucks t ON t.driver_id = d.id
   WHERE d.duty_status <> 'off'
   ORDER BY d.name`

// One driver's log for one simulated day: the day's window ($3 = 0 today,
// -1 yesterday, ...) and every active event overlapping it, with where it
// happened. The window is sim_day()'s own arithmetic (033), so "today" on
// this screen is the same day every other screen calls today.
export const DRIVER_DAY_LOG_SQL = `
  WITH day AS (
    SELECT sim_epoch()
             + (floor(EXTRACT(EPOCH FROM (now() - sim_epoch())) / $2::numeric) + $3::int)
               * ($2::numeric * interval '1 second') AS start
  ),
  win AS (
    SELECT start, start + ($2::numeric * interval '1 second') AS "end" FROM day
  )
  SELECT win.start AS "dayStart", win."end" AS "dayEnd", now() AS "now",
         (SELECT sim_day(win.start))::text AS "day",
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'id', e.id, 'status', e.status,
                     'startedAt', e.started_at, 'endedAt', e.ended_at,
                     'loadId', e.load_id, 'truckId', e.truck_id,
                     'routeOffsetMi', e.route_offset_mi,
                     'origin', e.origin, 'annotation', e.annotation,
                     'facility', CASE WHEN f.id IS NULL THEN NULL ELSE json_build_object(
                       'id', f.id, 'name', f.name, 'city', f.near_city, 'state', f.near_state) END
                   ) ORDER BY e.started_at)
              FROM duty_events e
              LEFT JOIN facilities f ON f.id = e.facility_id
             WHERE e.driver_id = $1 AND e.record_status = 'active'
               AND e.started_at < win."end" AND e.ended_at > win.start),
           '[]'::json
         ) AS events
    FROM win`

export const DRIVER_EXISTS_SQL = `
  SELECT id, name FROM drivers WHERE id = $1`

// HOS Violations: every working driver's active log since $1, plus the
// start of today's simulated day (the date range is counted in those
// days, the same days sim_day() names).
export const VIOLATIONS_SQL = `
  WITH clock AS (
    SELECT now() AS now,
           sim_epoch()
             + floor(EXTRACT(EPOCH FROM (now() - sim_epoch())) / $2::numeric)
               * ($2::numeric * interval '1 second') AS today_start
  )
  SELECT d.id AS "driverId", d.name AS "driverName",
         clock.now AS "now", clock.today_start AS "todayStart",
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'status', e.status, 'startedAt', e.started_at, 'endedAt', e.ended_at
                   ) ORDER BY e.started_at)
              FROM duty_events e
             WHERE e.driver_id = d.id AND e.record_status = 'active' AND e.ended_at > $1),
           '[]'::json
         ) AS events
    FROM drivers d
    CROSS JOIN clock
   WHERE d.duty_status <> 'off'
   ORDER BY d.name`

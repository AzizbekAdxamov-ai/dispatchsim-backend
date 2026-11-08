// SQL for /compliance (Driver HOS). sql-check PREPAREs every export here.
//
// $n "realSecPerSimDay" is simClock.js's REAL_SEC_PER_SIM_DAY, passed in
// rather than typed as a literal -- the same length sim_day() (073) steps
// by. Day boundaries come from sim_day_start() (073), which knows the
// 2026-11-08 change from 120 s to 1800 s days; do not rebuild them from
// sim_epoch() here.

// Every working driver (duty_status <> 'off' -- HR's "not working for the
// company"), their truck, and their active duty log since $1. One row per
// driver; events as a JSON array. The server's now() and the start of the
// next simulated day come back on every row so the service measures
// against the database's clock, not the app server's.
export const DRIVERS_HOS_SQL = `
  WITH clock AS (
    SELECT now() AS now,
           sim_day_start(now()) + ($2::numeric * interval '1 second') AS next_day_start
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
    SELECT sim_day_start(now()) + ($3::int * $2::numeric * interval '1 second') AS start
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

// Compliance > Driver Qualification: every working driver's DQ file
// (039) beside the facts the drivers table already owns -- CDL class,
// license expiry, HOS clocks' raw inputs, and the load they are on right
// now. The date columns come back raw; the service times them against
// the sim clock (driverQualification.js), because an expiry is a moving
// reading, not a stored verdict.
export const DRIVER_QUALIFICATION_SQL = `
  SELECT d.id AS "driverId", d.name AS "driverName",
         d.duty_status AS "dutyStatus",
         d.cdl_class AS "cdlClass",
         d.license_expires_on AS "licenseExpiresOn",
         d.hos_remaining_min AS "hosRemainingMin",
         dq.cdl_status AS "cdlStatus",
         dq.medical_expires_on AS "medicalExpiresOn",
         dq.medical_status AS "medicalStatus",
         dq.mvr_checked_on AS "mvrCheckedOn",
         dq.mvr_violations AS "mvrViolations",
         dq.mvr_status AS "mvrStatus",
         dq.da_status AS "daStatus",
         dq.updated_at AS "updatedAt",
         (SELECT l.id FROM loads l
           WHERE l.driver_id = d.id AND l.status IN ('ontime','warn','crit')
           ORDER BY l.dispatched_at DESC LIMIT 1) AS "currentLoadId",
         (SELECT count(*) FROM driver_qualification x
           WHERE x.driver_id = d.id) AS "dqRowExists"
    FROM drivers d
    LEFT JOIN driver_qualification dq ON dq.driver_id = d.id
   WHERE d.duty_status <> 'off'
   ORDER BY d.name`

// Compliance > Unassigned HOS: every ACTIVE unidentified driving record
// (038) -- the ELD's "who was driving?" queue. Grouped by truck and
// simulated day, the way the platform's own review screen groups them:
// a carrier reviews a day's records together (395.32(b) is a 24-hour
// rule). One row per truck per day; the segments come back as a JSON
// array carrying each record's id (assign/annotate act on these ids),
// its times, the load it was logged against, and what the original
// review said. No identified record is here -- only rows still waiting
// for a decision.
export const UNASSIGNED_HOS_SQL = `
  WITH day AS (
    SELECT sim_day_start(now()) - (gs * $1::numeric * interval '1 second') AS start
      FROM generate_series(0, $2::int) AS gs
  ),
  win AS (
    SELECT start, start + ($1::numeric * interval '1 second') AS "end",
           (sim_day(start))::text AS "day"
      FROM day
  )
  SELECT t.id AS "truckId", t.make AS "truckMake", t.model AS "truckModel",
         win.day AS "day", win.start AS "dayStart", win."end" AS "dayEnd",
         (SELECT json_agg(json_build_object(
                   'id', e.id,
                   'status', e.status,
                   'startedAt', e.started_at,
                   'endedAt', e.ended_at,
                   'loadId', e.load_id,
                   'origin', e.origin,
                   'recordStatus', e.record_status,
                   'annotation', e.annotation
                 ) ORDER BY e.started_at)
            FROM duty_events e
           WHERE e.truck_id = t.id AND e.driver_id IS NULL
             AND e.record_status = 'active' AND e.origin = 'unidentified'
             AND e.started_at < win."end" AND e.ended_at > win.start)
         AS segments
    FROM trucks t
    CROSS JOIN win
   WHERE EXISTS (
     SELECT 1 FROM duty_events e
      WHERE e.truck_id = t.id AND e.driver_id IS NULL
        AND e.record_status = 'active' AND e.origin = 'unidentified')
   ORDER BY win.start DESC, t.id`

// The one record a review acts on, with its truck -- the assign flow
// (395.32(d): the carrier names the driver) checks who the record
// belongs to before writing anything.
export const UNIDENTIFIED_EVENT_SQL = `
  SELECT e.id, e.driver_id AS "driverId", e.truck_id AS "truckId",
         e.status, e.started_at AS "startedAt", e.ended_at AS "endedAt",
         e.load_id AS "loadId", e.origin, e.record_status AS "recordStatus",
         t.id IS NOT NULL AS "hasTruck"
    FROM duty_events e
    LEFT JOIN trucks t ON t.id = e.truck_id
   WHERE e.id = $1`

// 395.32(d), the edit itself: the original record is NOT deleted -- it is
// marked 'inactive-changed', and a replacement in the driver's name is
// added with the carrier's note explaining the change. Two statements on
// purpose: the UPDATE must be tried first, so a record already marked
// inactive conflicts here (409) instead of inserting a phantom copy of
// someone's time (duty_events_one_active_start, 037, then guards the new
// row the same way it guards every other driver log).
export const ASSIGN_UNIDENTIFIED_EVENT_SQL = `
  UPDATE duty_events
     SET record_status = 'inactive-changed'
   WHERE id = $1 AND driver_id IS NULL AND origin = 'unidentified'
     AND record_status = 'active'
  RETURNING id`

export const ASSIGN_REPLACEMENT_EVENT_SQL = `
  INSERT INTO duty_events (
    driver_id, load_id, truck_id, status, started_at, ended_at,
    origin, annotation
  ) VALUES ($1, $2, $3, $4, $5, $6, 'carrier', $7)
  ON CONFLICT (driver_id, started_at) WHERE record_status = 'active' DO NOTHING
  RETURNING id`

// The other branch of the review: the record is explained, not owned. The
// original stays active as the record of the drive; a duplicate active
// unidentified row would be two records for one drive, so the annotation
// rides on the original and an empty result means it was already
// reviewed -- 409, like a second assign.
//
// `annotation IS NULL` is what makes that true. Without it the row stays
// active and unidentified after the first review, so a second annotate
// matched again, overwrote the carrier's earlier statement with no trace
// of it, and answered 200. Nothing on the screen could reach it -- the
// buttons hide once awaitingReview is false -- which is exactly the kind
// of rule this project keeps in a constraint rather than in a component:
// 49 CFR 395 requires the record to be RETAINED, and a silently replaced
// annotation is a destroyed one.
export const ANNOTATE_UNIDENTIFIED_EVENT_SQL = `
  UPDATE duty_events
     SET annotation = $2
   WHERE id = $1 AND driver_id IS NULL AND origin = 'unidentified'
     AND record_status = 'active' AND annotation IS NULL
  RETURNING id`

// HOS Violations: every working driver's active log since $1, plus the
// start of today's simulated day (the date range is counted in those
// days, the same days sim_day() names).
export const VIOLATIONS_SQL = `
  WITH clock AS (
    SELECT now() AS now,
           sim_day_start(now()) AS today_start
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

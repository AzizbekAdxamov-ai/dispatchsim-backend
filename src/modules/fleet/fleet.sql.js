// SQL for the truck-wear writes (migration 032 era). sql-check PREPAREs
// every export here, the same way it does for alerts.sql.js and the rest —
// a typo in a statement that only the tick executes would otherwise wait
// for 2am and a chat window.
//
// None of these are pretty-printed copies of the repositories: the repos
// import THESE strings and run them, so the checker checks what actually
// ships.

// Row-level lock held to the end of the caller's transaction.
export const LOCK_TRUCK_FOR_RUN_SQL = `
  SELECT id, odometer_mi AS "odometerMi", fuel_gallons AS "fuelGallons",
         fuel_capacity_gal AS "fuelCapacityGal", fuel_pct AS "fuelPct",
         tire_front_pct AS "tireFrontPct", tire_rear_pct AS "tireRearPct"
    FROM trucks WHERE id = $1 FOR UPDATE`

// One UPDATE per delivery. fuel_pct is recomputed in the same statement
// from the same gallons being written -- two columns, one fact. The
// odometer cap mirrors trucks_odometer's 2,000,000 bound.
// $6 is where the run ENDED. trucks.current_location had no writer at all
// until now -- it was seeded once and then frozen, which is why
// availability.service.js lists it among the columns no refusal may be
// built on. The delivery is the moment the truck's location is known for
// certain, so this is where it is written; the next dispatch reads it to
// work out how far the empty truck had to come (hos/repositioning.js).
export const APPLY_RUN_TO_TRUCK_SQL = `
  UPDATE trucks
     SET current_location = coalesce($6, current_location),
         odometer_mi     = least(2000000, odometer_mi + $2),
         fuel_gallons    = greatest(0, fuel_gallons - $3),
         fuel_pct        = greatest(0, least(100,
             round(100.0 * greatest(0, fuel_gallons - $3) / fuel_capacity_gal))),
         tire_front_pct  = greatest(0, tire_front_pct - $4),
         tire_rear_pct   = greatest(0, tire_rear_pct  - $5),
         updated_at      = now()
   WHERE id = $1
   RETURNING odometer_mi - $2 AS "odoBefore",
             odometer_mi      AS "odoAfter",
             greatest(0, fuel_gallons - $3) AS "gallonsAfter"`

// Fill the tank toward the target, never past it. last_fueled_at /
// last_fueled_location move together or not at all (trucks_fuel_log): the
// CASE keeps the pair paired without a second statement. The caller reads
// the row AFTER the UPDATE and computes gallonsAdded itself -- a RETURNING
// expression cannot mix old and new column values in one arithmetic line
// (least($2, cap) - fuel_gallons reads fuel_gallons as already-updated and
// returns 0 every time).
export const REFUEL_TRUCK_SQL = `
  UPDATE trucks
     SET fuel_gallons = least($2, fuel_capacity_gal),
         fuel_pct     = round(100.0 * least($2, fuel_capacity_gal) / fuel_capacity_gal),
         last_fueled_at =
           CASE WHEN least($2, fuel_capacity_gal) > fuel_gallons THEN now()
                ELSE last_fueled_at END,
         last_fueled_location =
           CASE WHEN least($2, fuel_capacity_gal) > fuel_gallons
                THEN current_location
                ELSE last_fueled_location END,
         updated_at = now()
   WHERE id = $1
   RETURNING fuel_gallons AS "gallonsAfter"`

// One day-row per call; the repo loops. ON CONFLICT sums into the day
// rather than crashing the tick on a retry, under the caps 009's CHECKs
// enforce.
export const ADD_DAILY_METRICS_SQL = `
  INSERT INTO truck_daily_metrics (truck_id, day, distance_mi, fuel_gallons, idle_minutes, fuel_pct_end)
  VALUES ($1, $2, $3, $4, 0, $5)
  ON CONFLICT (truck_id, day) DO UPDATE
    SET distance_mi  = least(900, truck_daily_metrics.distance_mi  + excluded.distance_mi),
        fuel_gallons = least(250, truck_daily_metrics.fuel_gallons + excluded.fuel_gallons),
        fuel_pct_end = excluded.fuel_pct_end`

// Miles already booked on each sim day in the window, so the new run can
// spread into the space that is left.
export const USED_MILES_BY_DAY_SQL = `
  SELECT day, distance_mi AS "distanceMi"
    FROM truck_daily_metrics
   WHERE truck_id = $1 AND day BETWEEN $2 AND $3`

// Open the work the odometer just made due. ON CONFLICT against
// maint_one_per_truck_service_mileage (032) is what makes the tick safe to
// run twice.
export const OPEN_SERVICE_DUE_SQL = `
  INSERT INTO maintenance_records (truck_id, service, status, due_date, due_mileage)
  VALUES ($1, $2, 'due', $3, $4)
  ON CONFLICT (truck_id, service, due_mileage) WHERE due_mileage IS NOT NULL DO NOTHING
  RETURNING id, truck_id AS "truckId", service, status,
            due_date AS "dueDate", due_mileage AS "dueMileage"`

// Mark the work finished and billed. Conditional on an open status so a
// second click reads zero rows and the caller raises SERVICE_ALREADY_DONE.
export const COMPLETE_SERVICE_SQL = `
  UPDATE maintenance_records
     SET status            = 'done',
         cost_usd          = $2,
         last_service_date = sim_today(),
         updated_at        = now()
   WHERE id = $1 AND status IN ('overdue', 'due', 'scheduled')
   RETURNING id, truck_id AS "truckId", service, cost_usd AS "costUsd"`

// The compressed calendar's today, as an ISO date string.
export const SIM_TODAY_SQL = `SELECT sim_today()::text AS day`

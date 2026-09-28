// SQL for pre_trip_inspections (migration 045) -- the pre-trip inspection,
// 49 CFR 392.7 with the 396.13 review of the last report. sql-check
// PREPAREs every export here against the real schema.
// preTrip.repository.js runs THESE strings.

// One inspection, written by the dispatch transaction. ON CONFLICT against
// pre_trip_one_per_load: a re-dispatched load's walk-around is a no-op,
// not a second copy -- the same discipline INSERT_DVIR_SQL keeps on the
// delivery side (markDelivered's conditional guard upstream).
export const INSERT_PRE_TRIP_SQL = `
  INSERT INTO pre_trip_inspections (
    truck_id, driver_id, load_id, odometer_mi,
    brakes_ok, lights_ok, tires_ok, steering_ok, coupling_ok,
    horn_ok, wipers_ok, mirrors_ok, emergency_eq_ok,
    parking_brake_ok, wheels_rims_ok,
    defects, reviewed_dvir_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)
  ON CONFLICT (load_id) DO NOTHING
  RETURNING id, truck_id AS "truckId", defects, reviewed_dvir_id AS "reviewedDvirId"`

// The board/read: recent inspections with the names the screen shows.
export const LIST_PRE_TRIP_SQL = `
  SELECT p.id, p.truck_id AS "truckId",
         jsonb_build_object('id', d.id, 'name', d.name) AS driver,
         p.load_id AS "loadId", p.odometer_mi AS "odometerMi",
         p.brakes_ok AS "brakesOk", p.lights_ok AS "lightsOk",
         p.tires_ok AS "tiresOk", p.steering_ok AS "steeringOk",
         p.coupling_ok AS "couplingOk", p.horn_ok AS "hornOk",
         p.wipers_ok AS "wipersOk", p.mirrors_ok AS "mirrorsOk",
         p.emergency_eq_ok AS "emergencyEqOk",
         p.parking_brake_ok AS "parkingBrakeOk",
         p.wheels_rims_ok AS "wheelsRimsOk",
         p.defects,
         jsonb_build_object(
           'id', r.id,
           'defects', r.defects,
           'defectsCorrected', r.defects_corrected
         ) AS "reviewedDvir",
         p.created_at AS "createdAt"
    FROM pre_trip_inspections p
    LEFT JOIN drivers d ON d.id = p.driver_id
    LEFT JOIN dvir_reports r ON r.id = p.reviewed_dvir_id
   ORDER BY p.created_at DESC
   LIMIT $1`

// The inspection a dispatch's outcome stands next to: this truck's most
// recent walk-around.
export const LATEST_FOR_TRUCK_SQL = `
  SELECT p.id, p.truck_id AS "truckId", p.load_id AS "loadId",
         p.defects, p.created_at AS "createdAt"
    FROM pre_trip_inspections p
   WHERE p.truck_id = $1
   ORDER BY p.created_at DESC
   LIMIT 1`

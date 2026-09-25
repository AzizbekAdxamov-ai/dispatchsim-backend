// SQL for dvir_reports (migration 040) -- the daily vehicle inspection
// report, 49 CFR 396.11. sql-check PREPAREs every export here.
// dvir.repository.js runs THESE strings.

// One report, written by the delivery transaction. The checklist is
// nine booleans, defects the JSON array, and the correction flag the
// rule the next driver's certification answers to. No conflict target:
// a report is written ONCE per delivery -- markDelivered's conditional
// guard upstream is what makes the tick's retry a no-op before this
// statement is ever reached.
export const INSERT_DVIR_SQL = `
  INSERT INTO dvir_reports (
    truck_id, driver_id, load_id, odometer_mi, location_label,
    brakes_ok, lights_ok, tires_ok, steering_ok, coupling_ok,
    horn_ok, wipers_ok, mirrors_ok, emergency_eq_ok,
    defects, notes, defects_corrected
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17)
  RETURNING id, truck_id AS "truckId", defects, notes, defects_corrected AS "defectsCorrected"`

// The board/list read: recent reports with the names the screen shows.
export const LIST_DVIR_SQL = `
  SELECT r.id, r.truck_id AS "truckId",
         jsonb_build_object('id', d.id, 'name', d.name) AS driver,
         r.load_id AS "loadId", r.odometer_mi AS "odometerMi",
         r.location_label AS "locationLabel",
         r.brakes_ok AS "brakesOk", r.lights_ok AS "lightsOk",
         r.tires_ok AS "tiresOk", r.steering_ok AS "steeringOk",
         r.coupling_ok AS "couplingOk", r.horn_ok AS "hornOk",
         r.wipers_ok AS "wipersOk", r.mirrors_ok AS "mirrorsOk",
         r.emergency_eq_ok AS "emergencyEqOk",
         r.defects, r.notes, r.defects_corrected AS "defectsCorrected",
         jsonb_build_object('id', c.id, 'name', c.name) AS "certifiedBy",
         r.certified_at AS "certifiedAt",
         r.created_at AS "createdAt"
    FROM dvir_reports r
    LEFT JOIN drivers d ON d.id = r.driver_id
    LEFT JOIN drivers c ON c.id = r.certified_by_driver_id
   ORDER BY r.created_at DESC
   LIMIT $1`

// The report a certification answers: this truck's most recent one.
export const LATEST_FOR_TRUCK_SQL = `
  SELECT r.id, r.truck_id AS "truckId", r.defects,
         r.defects_corrected AS "defectsCorrected",
         r.created_at AS "createdAt"
    FROM dvir_reports r
   WHERE r.truck_id = $1
   ORDER BY r.created_at DESC
   LIMIT 1`

// 396.13(b)(2), the write: certify the last report's defects as fixed.
// Conditional on defects_corrected = false -- certifying twice is not a
// second act, and a report already certified has nothing left to
// certify. Zero rows means it was already certified (or had no defects);
// the service decides what that means.
export const CERTIFY_DVIR_SQL = `
  UPDATE dvir_reports
     SET defects_corrected = true,
         certified_by_driver_id = $2,
         certified_at = now()
   WHERE id = $1 AND defects_corrected = false
   RETURNING id, defects_corrected AS "defectsCorrected",
             certified_by_driver_id AS "certifiedByDriverId"`

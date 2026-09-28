// Business logic for the DVIR module. The report is BORN in
// dispatch.service.js's delivery transaction -- this file holds the row
// builder that transaction calls, the list the Fleet screen reads, and
// the certification write the next driver's sign-off performs. The
// decision rule itself is constants/dvir.js's certificationDecision; a
// service never restates a rule the constants module owns.

import { AppError } from '../../lib/errors.js'
import { seedReport, certificationDecision, DVIR_ITEMS } from '../../constants/dvir.js'
import * as repo from './dvir.repository.js'
import * as preTripRepo from './preTrip.repository.js'
import { query } from '../../db/pool.js'

// The row the delivery transaction writes, from the post-delivery truck
// and the run's facts. Pure input, pure output -- the transaction does
// the writing, so a test can call this against a fixture and inspect the
// row without a database.
export function buildReportRow({ rng, truck, driverId, loadId, locationLabel, hadBreakdown }) {
  const report = seedReport({ rng, truck, hadBreakdown })
  return {
    truckId: truck.id,
    driverId: driverId ?? null,
    loadId: loadId ?? null,
    odometerMi: truck.odometerMi,
    locationLabel: locationLabel ?? null,
    brakesOk: report.items.brakes,
    lightsOk: report.items.lights,
    tiresOk: report.items.tires,
    steeringOk: report.items.steering,
    couplingOk: report.items.coupling,
    hornOk: report.items.horn,
    wipersOk: report.items.wipers,
    mirrorsOk: report.items.mirrors,
    emergencyEqOk: report.items.emergencyEq,
    defects: report.defects,
    notes: report.notes,
    defectsCorrected: false,
  }
}

// The list the Fleet screen reads. `client` (optional) lets a caller read
// inside its own transaction -- the schema-backed test inserts a row and
// reads it back before the runner's rollback, on the same connection.
//
// Alongside the reports rides each truck's most recent WALK-AROUND
// (392.7, written at dispatch) -- the cycle's other end, and the thing
// 396.13(b)(2)'s review duty connects the report to. Keyed by truck
// because 392.7 inspects the vehicle; one row per truck, the newest.
export async function listReports({ limit = 100 } = {}, client = null) {
  const [reports, walkArounds] = await Promise.all([
    repo.listReports({ limit }, client),
    preTripRepo.listInspections({ limit: 200 }, client),
  ])
  return {
    items: DVIR_ITEMS,
    reports: reports.map((r) => ({
      ...r,
      certification: certificationDecision(r),
    })),
    lastWalkAround: walkArounds,
  }
}

// POST /fleet/dvir/:id/certify -- the NEXT driver's 396.13(b)(2)
// sign-off. A defect-listed report nobody has certified holds the
// vehicle; this write clears it. The certifying driver must be the
// truck's CURRENT driver: the rule speaks of the driver who takes the
// vehicle next, and in this program that is the assignment on the truck.
// `client` (optional): run every read and write on that one connection,
// inside whatever transaction its owner opened -- the schema-backed test
// rides the same seam listReports takes.
export async function certifyReport({ reportId, driverId }, client = null) {
  const runner = client ?? query
  const row = await runner.query(
    `SELECT r.id, r.truck_id AS "truckId", r.defects,
            r.defects_corrected AS "defectsCorrected",
            (t.driver_id = $2) AS "isCurrentDriver"
       FROM dvir_reports r
       JOIN trucks t ON t.id = r.truck_id
      WHERE r.id = $1`,
    [reportId, driverId],
  )
  const report = row.rows[0]
  if (!report) throw new AppError('SERVICE_NOT_FOUND')
  if (!report.isCurrentDriver) throw new AppError('TRUCK_HAS_DRIVER')

  // No certificationDecision guard here: the open hold (defects listed,
  // nothing certified) is exactly what this write RESOLVES -- the decision
  // function is the screen's verdict, this endpoint is the cure. Under
  // migration 040 the guard was dead code (open-hold rows could not exist
  // at all), and keeping it past 041 made every real certification a
  // refusal. The repository's conditional UPDATE is the gate: a report
  // with nothing open certifies nothing, and returns null ->
  // SERVICE_ALREADY_DONE.
  const updated = await repo.certify(runner, { reportId, driverId })
  if (!updated) {
    // Already certified by someone -- the normal case a second click
    // produces, not an error.
    throw new AppError('SERVICE_ALREADY_DONE')
  }
  return { certified: true, reportId: updated.id }
}

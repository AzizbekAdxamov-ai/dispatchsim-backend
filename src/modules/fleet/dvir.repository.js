// Data access for `dvir_reports` (migration 040). The ONLY file that
// writes SQL against that table -- same "one file owns one table's
// writes" rule as dutyEvents.repository.js. Insert and certify take an
// optional client: the insert runs inside the delivery transaction (a
// report and the truck state it describes are one fact), the reads run
// on the pool.

import { query } from '../../db/pool.js'
import * as SQL from './dvir.sql.js'

export async function insertReport(client, r) {
  const result = await client.query(SQL.INSERT_DVIR_SQL, [
    r.truckId, r.driverId, r.loadId, r.odometerMi, r.locationLabel,
    r.brakesOk, r.lightsOk, r.tiresOk, r.steeringOk, r.couplingOk,
    r.hornOk, r.wipersOk, r.mirrorsOk, r.emergencyEqOk,
    JSON.stringify(r.defects), JSON.stringify(r.notes), r.defectsCorrected,
  ])
  return result.rows[0] ?? null
}

export async function listReports({ limit = 100 } = {}, client = null) {
  const runner = client ?? { query }
  const res = await runner.query(SQL.LIST_DVIR_SQL, [limit])
  return res.rows
}

export async function latestForTruck(truckId, client = null) {
  const runner = client ?? { query }
  const result = await runner.query(SQL.LATEST_FOR_TRUCK_SQL, [truckId])
  return result.rows[0] ?? null
}

// Returns the updated row, or null when the report was already certified
// -- the service decides whether that is a conflict or a no-op.
export async function certify(client, { reportId, driverId }) {
  const result = await client.query(SQL.CERTIFY_DVIR_SQL, [reportId, driverId])
  return result.rows[0] ?? null
}

// Data access for `pre_trip_inspections` (migration 045). The ONLY file
// that writes SQL against that table -- the same "one file owns one
// table's writes" rule dvir.repository.js keeps. The insert runs inside
// the dispatch transaction (the walk-around and the log block it rode are
// one fact); the reads run on the pool.

import { query } from '../../db/pool.js'
import * as SQL from './preTrip.sql.js'

export async function insertInspection(client, r) {
  const result = await client.query(SQL.INSERT_PRE_TRIP_SQL, [
    r.truckId, r.driverId, r.loadId, r.odometerMi,
    r.brakesOk, r.lightsOk, r.tiresOk, r.steeringOk, r.couplingOk,
    r.hornOk, r.wipersOk, r.mirrorsOk, r.emergencyEqOk,
    r.parkingBrakeOk, r.wheelsRimsOk,
    JSON.stringify(r.defects), r.reviewedDvirId,
  ])
  return result.rows[0] ?? null
}

export async function listInspections({ limit = 100 } = {}, client = null) {
  const runner = client ?? { query }
  const res = await runner.query(SQL.LIST_PRE_TRIP_SQL, [limit])
  return res.rows
}

export async function latestForTruck(truckId, client = null) {
  const runner = client ?? { query }
  const result = await runner.query(SQL.LATEST_FOR_TRUCK_SQL, [truckId])
  return result.rows[0] ?? null
}

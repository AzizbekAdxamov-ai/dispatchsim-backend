// Data-access layer for the `maintenance_records` table. This is the ONLY
// file in the codebase that writes SQL selecting FROM/writing INTO
// `maintenance_records` directly.

import { query } from '../../db/pool.js'
import { OPEN_SERVICE_DUE_SQL, COMPLETE_SERVICE_SQL } from './fleet.sql.js'

const MAINT_COLUMNS = `
  m.id, m.truck_id AS "truckId", m.service, m.status,
  m.due_date AS "dueDate", m.due_mileage AS "dueMileage",
  m.last_service_date AS "lastServiceDate", m.cost_usd AS "costUsd",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"
`

// /fleet/maintenance is not paginated (~45-50 records, see the plan's
// Endpointlar §"Sahifalash"). Ordered so the most urgent work (overdue,
// then soonest due) reads first, matching what a fleet manager actually
// triages first.
export async function listMaintenance({ limit = 200, offset = 0 } = {}) {
  const result = await query(
    `SELECT ${MAINT_COLUMNS}
     FROM maintenance_records m
     ORDER BY
       CASE m.status WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
       m.due_date ASC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return result.rows
}

// meta.counts for GET /fleet/maintenance's tab strip, plus monthCostUsd:
// completed work whose last_service_date falls in the current SIMULATED
// calendar month, the same total FleetMaintenance.jsx's monthly-cost figure
// adds up by hand from `cost` on `done` records (see maint_done_complete in
// migration 008 — `done` always has both a date and a cost).
//
// Both sides of the comparison are sim dates (032): date_trunc('month',
// sim_today()) on one side and sim_day() on the other. With one side left
// on the real calendar the window would only be open for the first few
// minutes of every real month and "this month" would silently mean
// "almost never".
export async function getMaintenanceSummary() {
  const result = await query(
    `SELECT
       count(*)::int                                             AS total,
       count(*) FILTER (WHERE status = 'overdue')::int            AS overdue,
       count(*) FILTER (WHERE status = 'due')::int                AS due,
       count(*) FILTER (WHERE status = 'scheduled')::int          AS scheduled,
       count(*) FILTER (WHERE status = 'done')::int                AS done,
       coalesce(sum(cost_usd) FILTER (
         WHERE status = 'done' AND date_trunc('month', sim_day(last_service_date)) = date_trunc('month', sim_today())
       ), 0)::int AS "monthCostUsd"
     FROM maintenance_records`,
  )
  return result.rows[0]
}

// Sum of maintenance cost for a single truck across two adjacent 7-day
// windows (current vs previous), keyed off last_service_date — used by
// fleet.service.js to build the truck detail page's maintenanceCost
// delta/up figure. Records without a last_service_date (open work) are
// naturally excluded since they can't fall in either window.
export async function getWeeklyCostByTruckId(truckId) {
  const result = await query(
    `SELECT
       coalesce(sum(cost_usd) FILTER (
         WHERE sim_day(last_service_date) >= (sim_today() - 7) AND sim_day(last_service_date) < sim_today()
       ), 0)::int AS "currentUsd",
       coalesce(sum(cost_usd) FILTER (
         WHERE sim_day(last_service_date) >= (sim_today() - 14) AND sim_day(last_service_date) < (sim_today() - 7)
       ), 0)::int AS "previousUsd"
     FROM maintenance_records
     WHERE truck_id = $1 AND status = 'done'`,
    [truckId],
  )
  return result.rows[0]
}

// ---------------------------------------------------------------------
// Writes (migration 032 era) — the service decides, the tick only opens
// ---------------------------------------------------------------------
// One record by id, for distinguishing "no such record" from "already
// done" in the service layer's error mapping.
export async function getById(recordId) {
  const result = await query(
    `SELECT ${MAINT_COLUMNS} FROM maintenance_records m WHERE m.id = $1`,
    [recordId],
  )
  return result.rows[0] ?? null
}

// Open the work the odometer just made due. ON CONFLICT against
// maint_one_per_truck_service_mileage (032) is what makes the tick safe to
// run twice: the second delivery crossing the same multiple inserts nothing.
// Returns the row it opened, or null when one was already open.
export async function openServiceDue(client, { truckId, service, dueMileage, dueDate }) {
  const result = await client.query(OPEN_SERVICE_DUE_SQL, [truckId, service, dueDate, dueMileage])
  return result.rows[0] ?? null
}

// Mark the work finished and billed. Conditional on an open status so a
// second click (or a second tab) reads zero rows and the caller raises
// SERVICE_ALREADY_DONE rather than billing twice.
export async function completeService(client, { recordId, costUsd }) {
  const result = await client.query(COMPLETE_SERVICE_SQL, [recordId, costUsd])
  return result.rows[0] ?? null
}

// Data-access layer for the `truck_daily_metrics` table (migration 009).
// This is the ONLY file in the codebase that writes SQL selecting FROM/
// writing INTO `truck_daily_metrics` directly.
//
// Every truck-detail figure derived from telemetry — weeklyDistance, mpg,
// idleHours, fuelTrend[], distanceTrend[] — and the dashboard's
// utilizationTrend[] all read from here. mpg is never stored (see the
// migration's comment): it is always sum(distance)/sum(gallons) over the
// window in question, computed in SQL so a truck that logged zero gallons
// in a window can't produce a divide-by-zero — NULLIF handles that.

import { query } from '../../db/pool.js'
import { ADD_DAILY_METRICS_SQL, USED_MILES_BY_DAY_SQL } from './fleet.sql.js'

// Two adjacent 7-day windows (current vs previous) in one round trip, for
// the weeklyDistance/mpg/idleHours deltaPct+up figures on GET
// /fleet/trucks/:id. `current` covers [today-7, today); `previous` covers
// [today-14, today-7).
//
// `day` is a SIMULATED day (migration 032's sim_day()) — `current_date` would
// be the real calendar, and a real calendar month holds ~720 sim days. Every
// window here is sim days, same clock the rows were written on.
export async function getWeeklyWindow(truckId) {
  const result = await query(
    `SELECT
       coalesce(sum(distance_mi)  FILTER (WHERE day >= sim_today() - 7),  0)::int AS "currentDistanceMi",
       coalesce(sum(fuel_gallons) FILTER (WHERE day >= sim_today() - 7),  0)::int AS "currentFuelGallons",
       coalesce(sum(idle_minutes) FILTER (WHERE day >= sim_today() - 7),  0)::int AS "currentIdleMinutes",
       coalesce(sum(distance_mi)  FILTER (WHERE day >= sim_today() - 14 AND day < sim_today() - 7), 0)::int AS "previousDistanceMi",
       coalesce(sum(fuel_gallons) FILTER (WHERE day >= sim_today() - 14 AND day < sim_today() - 7), 0)::int AS "previousFuelGallons",
       coalesce(sum(idle_minutes) FILTER (WHERE day >= sim_today() - 14 AND day < sim_today() - 7), 0)::int AS "previousIdleMinutes"
     FROM truck_daily_metrics
     WHERE truck_id = $1 AND day >= sim_today() - 14`,
    [truckId],
  )
  return result.rows[0]
}

// Last `days` calendar days of raw fuel-percent-at-end-of-day readings, for
// GET /fleet/trucks/:id's fuelTrend[]. Oldest first, so the frontend can
// plot it left-to-right without re-sorting.
export async function getFuelTrend(truckId, days = 7) {
  const result = await query(
    `SELECT day, fuel_pct_end AS "fuelPct"
     FROM truck_daily_metrics
     WHERE truck_id = $1 AND day >= sim_today() - $2::int
     ORDER BY day ASC`,
    [truckId, days],
  )
  return result.rows
}

// Last `days` calendar days of raw daily distance, for GET
// /fleet/trucks/:id's distanceTrend[].
export async function getDistanceTrend(truckId, days = 7) {
  const result = await query(
    `SELECT day, distance_mi AS "distanceMi"
     FROM truck_daily_metrics
     WHERE truck_id = $1 AND day >= sim_today() - $2::int
     ORDER BY day ASC`,
    [truckId, days],
  )
  return result.rows
}

// Fleet-wide utilization for the last `days` calendar days, for GET
// /stats/dashboard's utilizationTrend[]. `utilization` is the share of the
// fleet that moved at all that day (distance_mi > 0) — a truck sitting
// idle all day doesn't count even if it's nominally `active` status.
// `distanceMi` is the fleet's total miles that day, for the same chart's
// secondary series.
export async function getUtilizationTrend(days = 7) {
  const result = await query(
    `SELECT
       tdm.day,
       round(100.0 * count(*) FILTER (WHERE tdm.distance_mi > 0) / greatest(count(*), 1))::int AS utilization,
       coalesce(sum(tdm.distance_mi), 0)::int AS "distanceMi"
     FROM truck_daily_metrics tdm
     WHERE tdm.day >= sim_today() - $1::int
     GROUP BY tdm.day
     ORDER BY tdm.day ASC`,
    [days],
  )
  return result.rows
}

// Append the day-rows a delivered run produced. The PK (truck_id, day) plus
// ON CONFLICT DO UPDATE makes a retried delivery add to the same day's row
// rather than crash the tick on it -- the run that produced these rows was
// already marked delivered by the same transaction, so summing the miles in
// a second time cannot happen; the upsert exists so a partial retry (a tick
// that died between truck UPDATE and metrics INSERT) resumes instead of
// wedging that truck forever.
export async function addDailyMetrics(client, truckId, rows) {
  if (rows.length === 0) return
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(ADD_DAILY_METRICS_SQL, [
      truckId, row.day, row.distanceMi, row.fuelGallons, row.fuelPctEnd,
    ])
  }
}

// Miles this truck's rows ALREADY carry on each sim day in the window, so
// allocateRunDays can spread a new run into the space that is left. Day
// comes back as a Date (pg parses `date`); the allocation keys on the ISO
// string, UTC, the same way the seed writes them.
export async function usedMilesByDay(client, truckId, fromDay, toDay) {
  const result = await client.query(USED_MILES_BY_DAY_SQL, [truckId, fromDay, toDay])
  return Object.fromEntries(
    result.rows.map((r) => [
      r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      r.distanceMi,
    ]),
  )
}

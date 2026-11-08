// Aggregate/derived SQL for the Finance module.
//
// ⚠️ Deliberate exception to the "one table, one repository" rule (see the
// header comments on loads.repository.js / drivers.repository.js /
// trucks.repository.js / maintenance.repository.js / metrics.repository.js,
// which each own real writes to their table). Finance owns NO table of its
// own — there is no `invoices`, `settlements` or `expenses` table (see Q9
// in the plan: "Finance jadvalsiz quriladi"). Every figure here is a VIEW
// computed over loads/drivers/trucks/maintenance_records/
// truck_daily_metrics that those files have no reason to know about
// (an invoice's due date, an aging bucket, a driver's settlement gross
// pay). The plan's Qadam A9 explicitly sanctions this: "Finance oʻz
// repository sini yozmaydi ... yoki finance.repository.js faqat agregat
// soʻrovlar yozadi va bu fayl boshida sabab izohlanadi."
//
// This file therefore reads FROM loads/drivers/trucks/maintenance_records/
// truck_daily_metrics directly, but NEVER writes to any of them (no
// INSERT/UPDATE/DELETE appears below) and never duplicates a plain listing
// those files already expose — every query here computes something none
// of them do on their own.
//
// Fractional money (driver pay, fuel cost, margins, ...) is intentionally
// NOT computed in this SQL — see Qaror Q2 in the plan: `numeric` columns
// come back from node-pg as strings, so any calculation that can produce
// cents is done in JS with Math.round(n*100)/100 (see lib/money.js),
// never in SQL and never stored. Queries here return whole-dollar/integer
// ingredients (rate_usd, distance_mi, pay_percent_bp, ...) for
// finance.service.js to do that math on.

import { query } from '../../db/pool.js'
import { termsIntervalSql } from '../../constants/paymentTerms.js'
import { FINANCE_REAL_SEC_PER_SIM_DAY } from '../../constants/simClock.js'

// Every load, with its invoice status/dueAt/daysPastDue computed once so
// every query below stays consistent with the others. A load is a "draft"
// invoice until delivered (see Finance §"nima hisoblanadi" in the plan) —
// there is no separate invoices table, so this CTE IS the invoice list.
export const INVOICE_CTE = `
  WITH invoice_base AS (
    SELECT
      l.id AS "loadId", l.broker, l.rate_usd AS "rateUsd", l.accessorials,
      l.rate_basis AS "rateBasis", l.fuel_surcharge_usd AS "fuelSurchargeUsd",
      l.payment_terms AS "paymentTerms", l.booked_at AS "bookedAt",
      l.delivered_at AS "deliveredAt", l.invoice_paid_at AS "invoicePaidAt",
      -- invoice_due_at is what the TICK will actually pay against, on the
      -- finance calendar (2 real minutes per day). This
      -- used to recompute the date here as delivered_at + interval '30
      -- days', the real calendar -- so Finance and the collector
      -- disagreed by weeks and nothing was ever shown as overdue.
      -- The fallback keeps rows written before migration 019 readable.
      coalesce(l.invoice_due_at, l.delivered_at + (${termsIntervalSql()})) AS "dueAt"
    FROM loads l
    -- A cancelled load (migration 072) was never worked and never will be:
    -- no invoice, not even a draft. Without this it reads as deliveredAt
    -- IS NULL, so it showed up as a draft and inflated the draft count.
    WHERE l.status <> 'cancelled'
  ),
  invoice_status AS (
    SELECT ib.*,
      CASE
        WHEN ib."deliveredAt" IS NULL THEN 'draft'
        WHEN ib."invoicePaidAt" IS NOT NULL THEN 'paid'
        WHEN now() > ib."dueAt" THEN 'overdue'
        ELSE 'open'
      END AS status,
      -- Days past due, counted in SIMULATED days.
      --
      -- This was current_date - "dueAt"::date: real calendar days against
      -- a due date that lives on the compressed calendar, minutes rather
      -- than weeks away. Both dates therefore always fell on today and
      -- the answer was 0 for every invoice ever written -- the aging
      -- buckets, avgDaysToPay and the past-due badge were all reading a
      -- number that could not be anything else. One simulated day is
      -- FINANCE_REAL_SEC_PER_SIM_DAY real seconds; that is the only unit in which
      -- "45 days late" means what a student thinks it means.
      GREATEST(0, floor(
        EXTRACT(EPOCH FROM (now() - ib."dueAt")) / ${FINANCE_REAL_SEC_PER_SIM_DAY}
      ))::int AS "daysPastDue"
    FROM invoice_base ib
  )
`

function buildInvoiceFilter({ search }) {
  const params = []
  let clause = ''
  if (search) {
    params.push(`%${search}%`)
    clause = `WHERE ("loadId" ILIKE $${params.length} OR broker ILIKE $${params.length})`
  }
  return { clause, params }
}

export async function listInvoiceRows({ status, search, limit, offset }) {
  const { clause, params } = buildInvoiceFilter({ search })
  const conditions = clause ? [clause.replace(/^WHERE /, '')] : []

  if (status) {
    params.push(status)
    conditions.push(`status = $${params.length}`)
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const result = await query(
    `${INVOICE_CTE}
     SELECT "loadId", broker, "rateUsd", "rateBasis", "fuelSurchargeUsd", accessorials, "paymentTerms",
       "bookedAt", "deliveredAt", "invoicePaidAt", "dueAt", status, "daysPastDue"
     FROM invoice_status
     ${whereClause}
     ORDER BY "bookedAt" DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  return result.rows
}

export async function countInvoiceStatuses({ search }) {
  const { clause, params } = buildInvoiceFilter({ search })
  const result = await query(
    `${INVOICE_CTE}
     SELECT
       count(*)::int                                       AS "all",
       count(*) FILTER (WHERE status = 'draft')::int        AS draft,
       count(*) FILTER (WHERE status = 'open')::int         AS open,
       count(*) FILTER (WHERE status = 'overdue')::int      AS overdue,
       count(*) FILTER (WHERE status = 'paid')::int         AS paid
     FROM invoice_status
     ${clause}`,
    params,
  )
  return result.rows[0]
}

export async function getInvoiceRowByLoadId(loadId) {
  const result = await query(
    `${INVOICE_CTE}
     SELECT "loadId", broker, "rateUsd", "rateBasis", "fuelSurchargeUsd", accessorials, "paymentTerms",
       "bookedAt", "deliveredAt", "invoicePaidAt", "dueAt", status, "daysPastDue"
     FROM invoice_status
     WHERE "loadId" = $1`,
    [loadId],
  )
  return result.rows[0] ?? null
}

// Aging buckets over open+overdue ("receivables") invoices, bucketed by
// daysPastDue — 0-30/31-60/61-90/90+, matching financeData.js's BUCKETS.
export async function getAgingBuckets() {
  const result = await query(
    `${INVOICE_CTE}
     SELECT
       bucket.key, bucket.label,
       count(inv.*)::int AS count,
       coalesce(sum(inv."rateUsd" + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(inv.accessorials) a
       )), 0)::int AS "amountUsd"
     FROM (VALUES
       ('0-30',  '0-30 days',   -1,  30),
       ('31-60', '31-60 days',  30,  60),
       ('61-90', '61-90 days',  60,  90),
       ('90+',   '90+ days',    90, 2147483647)
     ) AS bucket(key, label, floor, ceiling)
     LEFT JOIN invoice_status inv
       ON inv.status IN ('open', 'overdue')
       AND inv."daysPastDue" > bucket.floor AND inv."daysPastDue" <= bucket.ceiling
     GROUP BY bucket.key, bucket.label, bucket.floor
     ORDER BY bucket.floor`,
  )
  return result.rows
}

// Headline KPI ingredients for GET /finance/overview. Kept as one round
// trip since every figure here is a simple sum/count/avg over the same
// invoice_status view.
export async function getInvoiceKpis() {
  const result = await query(
    `${INVOICE_CTE}
     SELECT
       coalesce(sum(("rateUsd" + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
       ))) FILTER (WHERE status IN ('open', 'overdue')), 0)::int AS "totalOutstandingUsd",
       coalesce(sum(("rateUsd" + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
       ))) FILTER (WHERE status = 'overdue'), 0)::int AS "pastDueTotalUsd",
       count(*) FILTER (WHERE status = 'overdue')::int AS "pastDueCount",
       coalesce(sum(("rateUsd" + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
       ))) FILTER (
         WHERE status = 'paid' AND date_trunc('month', "invoicePaidAt") = date_trunc('month', now())
       ), 0)::int AS "paidThisMonthUsd",
       -- Weighted "days to pay" over open+overdue balances, using a flat
       -- 30-day base term for the estimate regardless of actual
       -- payment_terms — this mirrors financeData.js's own approximation
       -- (avgDaysToPay), kept as-is per "mockdagi formulalar aynan" in the
       -- plan's Finance table rather than reworked into a truer weighted
       -- average.
       coalesce(round(avg(30 + "daysPastDue") FILTER (WHERE status IN ('open', 'overdue'))), 0)::int AS "avgDaysToPay"
     FROM invoice_status`,
  )
  return result.rows[0]
}

// Raw ingredients for loadProfitability[] — driverPay/fuelCost/otherCost/
// netProfit/marginPct/rpm are all fractional money, computed in JS (see
// the file header). Every load, not just delivered ones, matching
// financeData.js's loadProfitability (built from ALL of `loads`).
// Exported so the test can run it inside a rolled-back transaction (the
// pool-backed query() below would never see uncommitted fixture rows).
// A cancelled load earned nothing: its rate must not reach revenue or
// gross margin.
export const PROFITABILITY_SQL = `SELECT
       l.id AS "loadId", l.origin_city AS "originCity", l.origin_state AS "originState",
       l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
       l.broker, l.rate_usd AS "rateUsd", l.distance_mi AS "distanceMi",
       d.pay_model AS "payModel", d.pay_percent_bp AS "payPercentBp", d.pay_per_mile_cents AS "payPerMileCents"
     FROM loads l
     LEFT JOIN drivers d ON d.id = l.driver_id
     WHERE l.status <> 'cancelled'
     ORDER BY l.pickup_at DESC`

export async function listProfitabilityRows() {
  const result = await query(PROFITABILITY_SQL)
  return result.rows
}

// listSettlementInputs is gone with it. It fed a formula that recomputed
// driver pay from scratch on the real calendar while the money moved on
// the compressed one; driver_settlements (migration 025) is the record
// now, and payroll.sql.js asks it.


// Fuel spend for the current SIMULATED calendar month, one row per truck
// that fueled at all — mirrors maintenance.repository.js's
// getMaintenanceSummary "current month" window so fuel and maintenance
// expenses line up on the same period. Both sides sim days (032).
export async function listFuelExpenseRows() {
  const result = await query(
    `SELECT t.id AS "truckId", t.current_location AS "location",
            sum(m.fuel_gallons)::int AS "fuelGallons"
     FROM truck_daily_metrics m
     JOIN trucks t ON t.id = m.truck_id
     WHERE date_trunc('month', m.day) = date_trunc('month', sim_today())
     GROUP BY t.id, t.current_location
     HAVING sum(m.fuel_gallons) > 0
     ORDER BY t.id ASC`,
  )
  return result.rows
}

// Completed maintenance jobs billed in the current SIMULATED calendar
// month — same window maintenance.repository.js's monthCostUsd uses.
export async function listMaintenanceExpenseRows() {
  const result = await query(
    `SELECT id, truck_id AS "truckId", service, last_service_date AS "lastServiceDate", cost_usd AS "costUsd"
     FROM maintenance_records
     WHERE status = 'done' AND cost_usd IS NOT NULL
       AND date_trunc('month', sim_day(last_service_date)) = date_trunc('month', sim_today())
     ORDER BY last_service_date DESC`,
  )
  return result.rows
}

// Weekly revenue (delivered loads' invoiced amount) for the trailing
// `weeks` calendar weeks, for GET /finance/overview's cashFlowTrend[].
export async function getWeeklyRevenue(weeks) {
  const result = await query(
    `SELECT date_trunc('week', delivered_at)::date AS week,
            sum(rate_usd + (
              SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
            ))::int AS "revenueUsd"
     FROM loads
     WHERE delivered_at IS NOT NULL AND delivered_at >= current_date - ($1 * 7)
     GROUP BY 1
     ORDER BY 1`,
    [weeks],
  )
  return result.rows
}

// Weekly fuel gallons (all trucks), same trailing window, for the expense
// half of cashFlowTrend[]. Sim days — the rows are sim days.
export async function getWeeklyFuelGallons(weeks) {
  const result = await query(
    `SELECT date_trunc('week', day)::date AS week, sum(fuel_gallons)::int AS "fuelGallons"
     FROM truck_daily_metrics
     WHERE day >= sim_today() - ($1 * 7)
     GROUP BY 1
     ORDER BY 1`,
    [weeks],
  )
  return result.rows
}

// Weekly completed-maintenance cost, same trailing window. The cost's own
// date goes through sim_day() so both sides of the comparison sit on the
// same clock.
export async function getWeeklyMaintenanceCost(weeks) {
  const result = await query(
    `SELECT date_trunc('week', sim_day(last_service_date))::date AS week, sum(cost_usd)::int AS "costUsd"
     FROM maintenance_records
     WHERE status = 'done' AND sim_day(last_service_date) >= sim_today() - ($1 * 7)
     GROUP BY 1
     ORDER BY 1`,
    [weeks],
  )
  return result.rows
}

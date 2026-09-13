// Business logic for /finance/*. All fractional money math lives here (see
// lib/money.js and the header comment on finance.repository.js) — the
// repository only returns whole-dollar/integer ingredients.

import * as financeRepo from './finance.repository.js'
import * as payrollService from '../payroll/payroll.service.js'
import * as loadsRepo from '../loads/loads.repository.js'
import { AppError } from '../../lib/errors.js'
import { money } from '../../lib/money.js'
import {
  AVG_MPG,
  FUEL_PRICE_PER_GAL,
  FIXED_COST_PER_MILE,
  FACTORING_RATE,
  MONTHLY_INSURANCE,
  getAssumptions,
} from './finance.constants.js'

function accessorialsTotalUsd(accessorials) {
  return (accessorials ?? []).reduce((sum, a) => sum + (a.amountUsd ?? 0), 0)
}

// A load IS its invoice — there is no separate invoices table (Q9 in the
// plan). `id` is derived, never stored: 'INV-' + the year work on it
// wrapped up (delivered_at), or, for a still-in-transit "draft" invoice
// that has no delivered_at yet, the year it was booked instead.
function buildInvoice(row) {
  const accessorials = row.accessorials ?? []
  const amountUsd = money(row.rateUsd + accessorialsTotalUsd(accessorials))
  const year = new Date(row.deliveredAt ?? row.bookedAt).getFullYear()

  return {
    id: `INV-${year}-${row.loadId}`,
    loadId: row.loadId,
    broker: row.broker,
    amountUsd,
    paymentTerms: row.paymentTerms,
    status: row.status,
    issuedAt: row.deliveredAt,
    dueAt: row.dueAt,
    daysPastDue: row.daysPastDue,
    lineItems: [
      { label: 'Linehaul', amountUsd: row.rateUsd },
      ...accessorials.map((a) => ({ label: a.label, amountUsd: a.amountUsd })),
    ],
    payments: row.invoicePaidAt ? [{ paidAt: row.invoicePaidAt, amountUsd }] : [],
  }
}

export async function listInvoices({ status, search, page, limit }) {
  const offset = (page - 1) * limit
  const [rows, counts] = await Promise.all([
    financeRepo.listInvoiceRows({ status, search, limit, offset }),
    financeRepo.countInvoiceStatuses({ search }),
  ])
  return { invoices: rows.map(buildInvoice), meta: { total: counts.all, page, limit, counts } }
}

// `id` is the derived invoice id ('INV-2026-4471') — the loadId is the
// last '-'-separated segment, which is safe to split on because
// loads_id_format (migration 007) guarantees a load id is pure digits and
// can never itself contain a hyphen.
export async function getInvoiceById(id) {
  const loadId = id.split('-').at(-1)
  const [row, load] = await Promise.all([
    financeRepo.getInvoiceRowByLoadId(loadId),
    loadsRepo.getLoadById(loadId),
  ])

  if (!row || !load) {
    throw new AppError('LOAD_NOT_FOUND')
  }

  return { ...buildInvoice(row), load }
}

function buildProfitability(row) {
  const miles = row.distanceMi
  const driverPayUsd =
    row.payModel === 'percent' && row.payPercentBp != null
      ? money((row.rateUsd * row.payPercentBp) / 10000)
      : row.payModel === 'permile' && row.payPerMileCents != null
        ? money((miles * row.payPerMileCents) / 100)
        : 0
  const fuelCostUsd = money((miles / AVG_MPG) * FUEL_PRICE_PER_GAL)
  const otherCostUsd = money(miles * FIXED_COST_PER_MILE)
  const netProfitUsd = money(row.rateUsd - driverPayUsd - fuelCostUsd - otherCostUsd)

  return {
    loadId: row.loadId,
    originCity: row.originCity, originState: row.originState,
    destinationCity: row.destinationCity, destinationState: row.destinationState,
    broker: row.broker,
    rateUsd: row.rateUsd,
    distanceMi: miles,
    driverPayUsd, fuelCostUsd, otherCostUsd, netProfitUsd,
    marginPct: row.rateUsd ? Math.round((netProfitUsd / row.rateUsd) * 100) : 0,
    rpm: miles ? money(row.rateUsd / miles) : 0,
  }
}

const CASH_FLOW_WEEKS = 8

// Merges three independent weekly aggregates (revenue, fuel, maintenance)
// into one 8-week series, keyed by week start — SQL does the grouping,
// this just aligns three sparse result sets onto a dense list of week
// starts (a week with zero of something never gets its own SQL row).
function buildCashFlowTrend(revenueRows, fuelRows, maintenanceRows) {
  const byWeek = new Map()
  const weekKey = (d) => new Date(d).toISOString().slice(0, 10)

  const now = new Date()
  for (let i = CASH_FLOW_WEEKS - 1; i >= 0; i -= 1) {
    const weekStart = new Date(now)
    weekStart.setUTCHours(0, 0, 0, 0)
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay() - i * 7)
    byWeek.set(weekKey(weekStart), { weekStart: weekKey(weekStart), revenueUsd: 0, expensesUsd: 0 })
  }

  for (const row of revenueRows) {
    const key = weekKey(row.week)
    if (byWeek.has(key)) byWeek.get(key).revenueUsd += row.revenueUsd
  }
  for (const row of fuelRows) {
    const key = weekKey(row.week)
    if (byWeek.has(key)) byWeek.get(key).expensesUsd += money(row.fuelGallons * FUEL_PRICE_PER_GAL)
  }
  for (const row of maintenanceRows) {
    const key = weekKey(row.week)
    if (byWeek.has(key)) byWeek.get(key).expensesUsd += row.costUsd
  }

  return [...byWeek.values()]
}

export async function getOverview() {
  const [kpis, agingBuckets, profitabilityRows, revenueRows, fuelRows, maintenanceRows] = await Promise.all([
    financeRepo.getInvoiceKpis(),
    financeRepo.getAgingBuckets(),
    financeRepo.listProfitabilityRows(),
    financeRepo.getWeeklyRevenue(CASH_FLOW_WEEKS),
    financeRepo.getWeeklyFuelGallons(CASH_FLOW_WEEKS),
    financeRepo.getWeeklyMaintenanceCost(CASH_FLOW_WEEKS),
  ])

  const loadProfitability = profitabilityRows.map(buildProfitability)
  const totalRevenueUsd = money(loadProfitability.reduce((sum, l) => sum + l.rateUsd, 0))
  const totalNetProfitUsd = money(loadProfitability.reduce((sum, l) => sum + l.netProfitUsd, 0))
  const totalMiles = loadProfitability.reduce((sum, l) => sum + l.distanceMi, 0)

  // totalExpenses/costPerMile mirror listExpenses()'s own total (current
  // calendar month fuel + maintenance + fixed costs) rather than
  // recomputing a second way — see listExpenses below for the shared
  // "current month" window.
  const { expenses, meta: expensesMeta } = await listExpenses()

  return {
    totalOutstandingUsd: kpis.totalOutstandingUsd,
    pastDueTotalUsd: kpis.pastDueTotalUsd,
    pastDueCount: kpis.pastDueCount,
    paidThisMonthUsd: kpis.paidThisMonthUsd,
    avgDaysToPay: kpis.avgDaysToPay,
    grossMarginPct: totalRevenueUsd ? Math.round((totalNetProfitUsd / totalRevenueUsd) * 100) : 0,
    totalExpensesUsd: expensesMeta.totalUsd,
    costPerMileUsd: totalMiles ? money(expensesMeta.totalUsd / totalMiles) : 0,
    agingBuckets: agingBuckets.map((b) => ({ key: b.key, label: b.label, count: b.count, amountUsd: b.amountUsd })),
    cashFlowTrend: buildCashFlowTrend(revenueRows, fuelRows, maintenanceRows),
    loadProfitability,
    assumptions: getAssumptions(),
  }
}

// Settlements moved to the payroll module.
//
// What used to live here was a second, incompatible pay system. It
// recomputed gross with a formula the ledger never used (falling back to
// `miles * 0.55`), applied a Fuel advance deduction that no payment ever
// charged, ran on real calendar weeks while the money moved on the
// compressed one, and derived status as `periodEnd < oneWeekAgo` -- which
// for the current period is false by construction, so every settlement the
// student could see read 'pending' and could never read anything else.
//
// Meanwhile the actual money left the account through settlementFor() at
// delivery. Two numbers described one payment and the visible one was the
// invented one. driver_settlements (migration 025) is now the single
// record: what was earned, what is owed, what was paid, and when.
//
// This function stays so /finance/settlements keeps working; it is a
// forward, not a second implementation.
export async function listSettlements() {
  return payrollService.listSettlements()
}

export async function listExpenses() {
  const [fuelRows, maintenanceRows, kpis] = await Promise.all([
    financeRepo.listFuelExpenseRows(),
    financeRepo.listMaintenanceExpenseRows(),
    financeRepo.getInvoiceKpis(),
  ])

  const fuelExpenses = fuelRows.map((r) => ({
    id: `ex-fuel-${r.truckId}`,
    category: 'fuel',
    truckId: r.truckId,
    description: `Fuel — ${r.location ?? 'unknown location'}`,
    amountUsd: money(r.fuelGallons * FUEL_PRICE_PER_GAL),
  }))

  const maintenanceExpenses = maintenanceRows.map((r) => ({
    id: `ex-maint-${r.id}`,
    category: 'maintenance',
    truckId: r.truckId,
    description: r.service,
    date: r.lastServiceDate,
    amountUsd: r.costUsd,
  }))

  const fixedExpenses = [
    { id: 'ex-ins-1', category: 'insurance', truckId: null, description: 'Commercial auto & cargo premium', amountUsd: MONTHLY_INSURANCE },
    { id: 'ex-fact-1', category: 'other', truckId: null, description: 'Factoring fee (receivables)', amountUsd: money(kpis.totalOutstandingUsd * FACTORING_RATE) },
  ]

  const expenses = [...fuelExpenses, ...maintenanceExpenses, ...fixedExpenses]
  const totalUsd = money(expenses.reduce((sum, e) => sum + e.amountUsd, 0))

  const byCategory = {}
  for (const e of expenses) {
    byCategory[e.category] = money((byCategory[e.category] ?? 0) + e.amountUsd)
  }

  return { expenses, meta: { byCategory, totalUsd } }
}

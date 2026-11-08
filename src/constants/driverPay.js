// What a driver earns on a load, and what comes out of it.
//
// Settlement is written when the load DELIVERS, not when the broker pays.
// That is how a real carrier works and it is the whole point: the driver
// is paid this week, the invoice lands in thirty to sixty days, and the
// gap between those two facts is what puts small carriers out of business.
// Paying the driver out of the broker's money would quietly delete the
// squeeze the entire cash model exists to teach.
//
// EARNED per load, PAID on a payroll run. Earning per load keeps the cause
// visible -- this run earned this much and cost this much, readable off
// the ledger. Paying on a run is what makes it a decision: money used to
// leave the account at delivery with nobody choosing to send it, which
// meant a driver could never be owed anything and so could never have a
// grievance. See migration 025.
import {
  ESCROW_USD,
  OCCUPATIONAL_INSURANCE_USD,
  FUEL_CARD_FEE_USD,
} from '../modules/finance/finance.constants.js'

// Deductions are per settlement in the real world, weekly. Charging the
// full weekly amount on every load would punish short runs absurdly -- a
// 200-mile local would lose $97 of a $400 gross -- so they are prorated
// against a nominal week's work.
export const MILES_PER_SETTLEMENT_WEEK = 2500

export function settlementFor({ rateUsd, distanceMi, payModel, payPercentBp, payPerMileCents }) {
  let gross = 0
  if (payModel === 'percent' && payPercentBp != null) {
    gross = Math.round((rateUsd * payPercentBp) / 10000)
  } else if (payModel === 'permile' && payPerMileCents != null) {
    gross = Math.round((distanceMi * payPerMileCents) / 100)
  }
  if (gross <= 0) return null

  const weekFraction = Math.min(1, distanceMi / MILES_PER_SETTLEMENT_WEEK)
  const fullDeductions = Math.round(
    (ESCROW_USD + OCCUPATIONAL_INSURANCE_USD + FUEL_CARD_FEE_USD) * weekFraction,
  )

  // A settlement never takes money back off a driver, and the clamp is on
  // DEDUCTIONS rather than on net.
  //
  // Clamping net instead would leave net = 0 while gross - deductions was
  // negative, and driver_settlements.settlement_net_matches requires those
  // to agree: the row would be refused and the delivery tick would throw
  // on a load, for a reason no student caused. Today no combination the
  // schema allows can reach that -- the smallest gross the CHECKs permit
  // still clears the largest prorated deduction -- but the invariant now
  // holds by construction rather than by the current value of three
  // constants in finance.constants.js.
  const deductions = Math.min(fullDeductions, gross)
  return { gross, deductions, net: gross - deductions }
}

// ---------------------------------------------------------------------
// When it is owed, and what happens when it is not paid
// ---------------------------------------------------------------------

// Settlements in US trucking run weekly. Seven simulated days is that norm
// on this calendar -- fourteen real minutes (a money-wait day is two real
// minutes, FINANCE_REAL_MS_PER_SIM_DAY) -- and it is the line a driver
// measures lateness from. Not a threshold somebody picked: it is the
// industry's own cycle, which is why a driver treats missing it as a
// broken promise rather than as an inconvenience.
export const SETTLEMENT_TERM_SIM_DAYS = 7

// What being owed does to a person, in stages.
//
// Stages, rather than one switch, because the lesson is not "pay or the
// simulator punishes you" -- it is that a person who is owed money tells
// you first, several times, and only stops working when telling you has
// not worked. Each stage leaves the dispatcher room to fix it, and the
// last one is irreversible in the way a real resignation is.
export const DRIVER_STAGES = Object.freeze({
  // Past due at all: raises it in chat, keeps driving.
  asks: 0,
  // A full extra cycle late: will not accept new work.
  refuses: 7,
  // Two cycles late: leaves, and the truck sits.
  quits: 14,
})

// How overdue the driver's OLDEST unpaid settlement is, in simulated days.
// The oldest, not the total: someone owed $200 for three weeks has a
// sharper grievance than someone owed $4,000 since yesterday, and it is
// the waiting that makes a person quit.
export function stageFor(daysOverdue) {
  if (daysOverdue == null || daysOverdue < DRIVER_STAGES.asks) return 'ok'
  if (daysOverdue >= DRIVER_STAGES.quits) return 'quits'
  if (daysOverdue >= DRIVER_STAGES.refuses) return 'refuses'
  return 'asks'
}

// Only one stage stops work. Stated as a function so no caller has to
// remember which strings mean "will not take the load".
export function willAcceptWork(stage) {
  return stage === 'ok' || stage === 'asks'
}

// How a wait is SAID, as opposed to how it is decided.
//
// stageFor() keeps working on the exact day count; this only chooses the
// words. Past two weeks a person stops counting days -- and the count
// itself stops being trustworthy: it is simulated time, and a company
// left running over a weekend reads "300 days" for money that was never
// really late that long. "a few weeks" and "over two months" say the same
// thing a driver would, without pinning a number the world cannot back.
export const WAIT_EXACT_MAX_DAYS = 14
export const WAIT_WEEKS_MAX_DAYS = 60

export function describeWait(days) {
  const n = Math.max(0, Math.floor(Number(days) || 0))
  if (n <= WAIT_EXACT_MAX_DAYS) return `${n} ${n === 1 ? 'day' : 'days'}`
  if (n <= WAIT_WEEKS_MAX_DAYS) return 'a few weeks'
  return 'over two months'
}

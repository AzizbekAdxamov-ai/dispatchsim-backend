// The compressed calendar, and the money constants that ride on it.
//
// The simulator runs two clocks on purpose. The MARKETPLACE runs in real
// time -- postings drip onto the board, a broker takes real seconds to
// answer -- because that is what makes a dispatcher work several loads at
// once, and it already works. The COMPANY runs on a compressed calendar,
// because the lessons on that side are measured in days and weeks: a
// four-day run, a net60 invoice, interest on a credit line.
//
// One simulated day is two real minutes. A student sees a load dispatched,
// eight minutes of transit, delivery, and then the wait for money -- half
// an hour from an A-rated broker, two hours from a D. That difference is
// the entire argument for checking a broker before you haul for them, and
// at real scale nobody would ever live long enough to feel it.
export const REAL_MS_PER_SIM_DAY = 2 * 60 * 1000
export const REAL_MIN_PER_SIM_DAY = REAL_MS_PER_SIM_DAY / 60000
export const REAL_SEC_PER_SIM_DAY = REAL_MS_PER_SIM_DAY / 1000

export function simDaysToMs(days) {
  return Math.round(days * REAL_MS_PER_SIM_DAY)
}

// Whole seconds, for SQL. make_interval's `mins` parameter is an integer
// and rejects the fractional day counts a transit window produces, so the
// conversion happens here and the database receives one integer:
//   now() + ($n::int * interval '1 second')
// Floored at 1 so a zero-length window still advances time.
export function simDaysToSeconds(days) {
  return Math.max(1, Math.round(days * REAL_MS_PER_SIM_DAY / 1000))
}

// How many simulated days have passed in a real interval.
export function msToSimDays(ms) {
  return ms / REAL_MS_PER_SIM_DAY
}

// LATE_REVEAL_FRACTION lived here and is gone with delayFactor.
//
// It held a lateness flag back until 60% of a run, because eta_at used to
// be decided at dispatch and the simulator therefore knew at second zero
// which loads would run late. Publishing that immediately would have put a
// forecast on the board dressed as a fact.
//
// Since migration 027 an ETA only moves when a road event is resolved, so
// by the time a load is running late the driver has already called it in.
// There is nothing left to hold back, and holding it back would now do the
// opposite harm: the chat saying "I am stuck in the snow" while the board
// still read on time.

// How much simulated time one tick is allowed to bill for.
//
// The bug this exists to stop: interest and insurance were charged from
// WALL-CLOCK elapsed time, while everything else in the simulator is
// event-driven and simply catches up once. Close the laptop for eight real
// hours and the next tick bills 240 simulated days of interest and eight
// months of fleet insurance -- against a company that hauled nothing,
// collected nothing, and delivered nothing during those eight hours,
// because the tick that does all of that was not running either.
//
// One session's log: -$168,584, then -$171,494, then -$171,588, climbing
// every tick from an opening balance of $200,000. The credit line is
// $50,000; the company was three and a half times past it and no decision
// the student made had put it there.
//
// Five real minutes is the line. The tick is meant to run every 30 real
// seconds locally and every 60 on Vercel, whose cron floor that is; even a
// slow cold start does not take five minutes. A longer gap means the
// simulator was not running, so nothing in this world happened, and the
// company should not be billed for it. The skipped time is DROPPED, not
// deferred -- lastAt moves to now either way.
export const MAX_CATCHUP_REAL_MS = 5 * 60 * 1000
export const MAX_CATCHUP_SIM_DAYS = MAX_CATCHUP_REAL_MS / REAL_MS_PER_SIM_DAY

// Simulated days to bill for, given how long since the last charge.
// Returns the elapsed time, or the cap when the gap says the simulator was
// asleep.
export function billableSimDays(elapsedMs) {
  if (!(elapsedMs > 0)) return 0
  return Math.min(elapsedMs, MAX_CATCHUP_REAL_MS) / REAL_MS_PER_SIM_DAY
}

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

// Enough to buy a truck and still have working capital, not so much that
// the first few decisions do not matter. $200,000 is Azizbek's figure
// (2026-09-30): the company starts with ONE truck and ONE driver -- the
// Telegram bot's Grace Lindqvist -- and the tighter purse is the point.
//
// This is where the number lives for the APP. A migration cannot import
// it -- SQL has no access to this file -- so 021 spelled 200000 out and
// 031 moved it to 250000, and now 050 moves it back to 200000. Every
// database therefore ends up at the last figure whichever order it was
// built in, but the two places are kept in step by a test, not by hope:
// test/openingBalance.test.js fails if this constant and the last
// migration that sets it ever disagree.
//
// scripts/reset-company.js writes the row from THIS constant, so a reset
// always produces whatever is written here.
export const OPENING_BALANCE_USD = 200000

// The balance is allowed to go negative. Refusing the purchase would be a
// block, and this project's rule is consequence over blocking: the student
// buys the second truck, and then watches interest come out every
// simulated day until a load pays. Cash management is what actually kills
// small carriers, and it cannot be taught by a disabled button.
export const CREDIT_LIMIT_USD = 50000
export const CREDIT_APR = 0.18

// What the money costs once the line is used up.
//
// The balance kept going past -$50,000 and nothing about the deal changed.
// Interest accrued at the same 18% on a facility that had been exhausted
// three times over, compounding against a company with no revenue -- one
// observed session sat at -$180,899 and fell $69 every thirty seconds with
// nothing in transit. A real lender does not watch that happen at the
// contract rate.
//
// Two tiers, which is how a real facility is actually written: the first
// $50,000 is the committed line and carries the contract rate. Anything
// beyond it is an unauthorised overdraft and carries the contract rate
// plus a default margin. Six points is the usual shape of a default clause
// in a US commercial credit agreement -- it is stated here as a term of
// THIS facility rather than as a universal figure.
export const DEFAULT_MARGIN = 0.06
export const OVER_LIMIT_APR = CREDIT_APR + DEFAULT_MARGIN

// Interest for `simDays`, split across the two tiers. Unrounded; the tick
// carries the fraction forward in sim_state.
export function interestForPeriodExactTiered(balanceUsd, simDays) {
  if (balanceUsd >= 0 || simDays <= 0) return 0
  const owed = Math.abs(balanceUsd)
  const withinLine = Math.min(owed, CREDIT_LIMIT_USD)
  const overLine = Math.max(0, owed - CREDIT_LIMIT_USD)
  return ((withinLine * CREDIT_APR) + (overLine * OVER_LIMIT_APR)) * simDays / 365
}

// Interest owed for `simDays` spent at `balanceUsd` below zero, in whole
// dollars. 0 when the account is in the black.
export function interestForPeriod(balanceUsd, simDays) {
  return Math.round(interestForPeriodExact(balanceUsd, simDays))
}

// The same figure unrounded.
//
// The tick charges every 30 real seconds -- a quarter of a simulated day.
// At -$10,000 the true charge per tick is $1.23, and Math.round drops the
// $0.23 every single time: about a fifth LESS than the rate says, not
// more. Worse, below roughly -$4,055 the per-tick figure falls under half
// a dollar and rounds to zero, so a student carrying a small balance
// would be charged nothing at all, forever, at an advertised 18% APR.
//
// The direction of the error depends on the balance, which is harder to
// notice than a consistent bias. So the fraction is carried forward in
// sim_state and only whole dollars ever reach the ledger.
//
// (The earlier version of this comment claimed rounding billed a fifth
// MORE. It was wrong, and stayed wrong until money.test.js measured it.)
export function interestForPeriodExact(balanceUsd, simDays) {
  if (balanceUsd >= 0 || simDays <= 0) return 0
  return (Math.abs(balanceUsd) * CREDIT_APR * simDays) / 365
}

// A hire is not free: DOT physical, drug screen, MVR pull, orientation.
// Small enough not to dominate, large enough that hiring five drivers you
// have no trucks for is visible in the ledger.
export const DRIVER_ONBOARDING_USD = 350

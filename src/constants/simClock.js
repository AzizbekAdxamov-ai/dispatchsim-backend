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

// How far into a run a delay becomes visible.
//
// eta_at is decided at dispatch, so the simulator knows at second zero
// which loads will overshoot. Publishing that immediately would put a
// forecast on the board dressed as a fact -- the student would see
// 'warn' before the truck had moved. A driver notices the scale queue
// and the weather somewhere past the middle of the run, and calls it in
// then. 0.6 of the promised window is that point.
//
// It does not affect 'crit': a promise that has already passed is an
// observed fact and needs no delay before it is stated.
export const LATE_REVEAL_FRACTION = 0.6

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

// Enough to buy a truck and still have working capital, not so much that
// the first few decisions do not matter.
export const OPENING_BALANCE_USD = 200000

// The balance is allowed to go negative. Refusing the purchase would be a
// block, and this project's rule is consequence over blocking: the student
// buys the second truck, and then watches interest come out every
// simulated day until a load pays. Cash management is what actually kills
// small carriers, and it cannot be taught by a disabled button.
export const CREDIT_LIMIT_USD = 50000
export const CREDIT_APR = 0.18

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

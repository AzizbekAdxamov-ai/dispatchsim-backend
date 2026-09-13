// Is the company still a going concern?
//
// The simulator had no failure state. A balance could fall past the
// $50,000 credit line and keep falling forever -- one session reached
// -$180,899 and was dropping $69 every thirty seconds with nothing in
// transit. That is not "consequence over blocking", it is a number growing
// with no consequence at all, and it removes the single most important
// lesson the cash model exists to teach: what actually kills small
// carriers is running out of money.
//
// Three states, and every one of them is a FACT the student can check,
// not a verdict:
//
//   ok          the line is untouched or within its limit.
//   over_limit  past $50,000 of credit. The lender has stopped advancing,
//               and the balance beyond the line carries the default rate.
//               Costs already incurred still land -- you cannot un-burn
//               diesel or un-earn a driver's wages.
//   insolvent   liabilities exceed assets. This is the balance-sheet
//               insolvency test, the same one an accountant would apply,
//               not a threshold somebody picked.

import { query } from '../../db/pool.js'
import * as SQL from './solvency.sql.js'
import { truckValueUsd } from '../../constants/truckValue.js'
import { CREDIT_LIMIT_USD, CREDIT_APR, OVER_LIMIT_APR } from '../../constants/simClock.js'

export const STATES = Object.freeze({
  OK: 'ok',
  OVER_LIMIT: 'over_limit',
  INSOLVENT: 'insolvent',
})

export async function solvency(client = null) {
  const runner = client ?? { query }
  const [sheet, fleet] = await Promise.all([
    runner.query(SQL.BALANCE_SHEET_SQL),
    runner.query(SQL.FLEET_FOR_VALUATION_SQL),
  ])
  const row = sheet.rows[0]

  const fleetValueUsd = fleet.rows.reduce((sum, t) => sum + truckValueUsd(t), 0)
  const assetsUsd = row.receivablesUsd + fleetValueUsd
  // Only a NEGATIVE balance is a liability. Cash in the bank is an asset
  // and is already the thing the balance measures.
  const debtUsd = Math.max(0, -row.balanceUsd)
  const liabilitiesUsd = debtUsd + row.unpaidWagesUsd

  const overLimit = row.balanceUsd < -CREDIT_LIMIT_USD
  const insolvent = liabilitiesUsd > assetsUsd

  let state = STATES.OK
  if (insolvent) state = STATES.INSOLVENT
  else if (overLimit) state = STATES.OVER_LIMIT

  return {
    state,
    balanceUsd: row.balanceUsd,
    creditLimitUsd: CREDIT_LIMIT_USD,
    // How much of the line is left to draw on. Negative means past it.
    creditAvailableUsd: CREDIT_LIMIT_USD + Math.min(0, row.balanceUsd),
    overLimitUsd: Math.max(0, debtUsd - CREDIT_LIMIT_USD),
    aprWithinLine: CREDIT_APR,
    aprOverLine: OVER_LIMIT_APR,
    assetsUsd,
    liabilitiesUsd,
    receivablesUsd: row.receivablesUsd,
    fleetValueUsd,
    truckCount: row.truckCount,
    unpaidWagesUsd: row.unpaidWagesUsd,
    // What the company is worth. Negative is the definition of insolvent.
    netWorthUsd: assetsUsd - liabilitiesUsd,
  }
}

// Can the company take on something new?
//
// Booking a load, hiring a driver and buying a truck all commit money the
// company does not have. Past the line the LENDER declines -- that is a
// fact about the world, not the program protecting the student from a
// choice. Work already in transit still finishes, invoices still get
// collected, and drivers still get paid when payroll runs: that is what a
// wind-down looks like, and stopping it would be the software inventing a
// rule nobody has.
export function canCommitNewWork(state) {
  return state === STATES.OK
}

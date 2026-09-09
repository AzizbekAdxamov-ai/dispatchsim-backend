// What a driver earns on a load, and what comes out of it.
//
// Settlement is written when the load DELIVERS, not when the broker pays.
// That is how a real carrier works and it is the whole point: the driver
// is paid this week, the invoice lands in thirty to sixty days, and the
// gap between those two facts is what puts small carriers out of business.
// Paying the driver out of the broker's money would quietly delete the
// squeeze the entire cash model exists to teach.
//
// Per load rather than per week. A weekly cycle on the compressed
// calendar is fourteen real minutes and would need its own scheduler; per
// load keeps the cause visible -- this run earned this much and cost this
// much -- which is what a student is meant to read off the ledger.
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
  const deductions = Math.round(
    (ESCROW_USD + OCCUPATIONAL_INSURANCE_USD + FUEL_CARD_FEE_USD) * weekFraction,
  )

  // Never below zero: a settlement that takes money back off a driver is
  // not something this simulator should be able to produce by accident.
  const net = Math.max(0, gross - deductions)
  return { gross, deductions, net }
}

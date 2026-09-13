// What a Class 8 truck is worth.
//
// One model, two callers. seed/trucks.js prices a listing with it, and the
// solvency test values the fleet with it. Before, the pricing lived inline
// in the seed script and the solvency test did not exist -- so the first
// thing that needed to ask "what is this company's fleet worth" would have
// invented a second answer, and the market would have priced a truck one
// way while the balance sheet priced it another.
//
// The shape is the real one: a truck loses value with age and with miles,
// and those are the two numbers a buyer actually looks at.
export const NEW_TRUCK_BASE_USD = 80000
export const BASE_YEAR = 2015
export const PER_YEAR_NEWER_USD = 5000
// Per 10,000 miles on the clock.
export const PER_10K_MILES_USD = 200

export const MIN_VALUE_USD = 5000
export const MAX_VALUE_USD = 250000

export function truckValueUsd({ year, odometerMi }) {
  const base = NEW_TRUCK_BASE_USD + (year - BASE_YEAR) * PER_YEAR_NEWER_USD
  const odometerDiscount = Math.floor((odometerMi ?? 0) / 10000) * PER_10K_MILES_USD
  return Math.max(MIN_VALUE_USD, Math.min(MAX_VALUE_USD, base - odometerDiscount))
}

// The same figure with the seller's spread on it. A listing is not the
// book value: two identical trucks on the same lot carry different asking
// prices, and a student who sees three 2021 Cascadias at exactly one price
// is looking at a spreadsheet, not a market.
export function listingPriceUsd({ year, odometerMi, rng }) {
  const value = truckValueUsd({ year, odometerMi })
  const spread = Math.floor(rng() * 10000) - 5000
  return Math.max(MIN_VALUE_USD, Math.min(MAX_VALUE_USD, value + spread))
}

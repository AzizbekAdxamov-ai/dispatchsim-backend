// Assumptions the finance/fleet cost math is built on. Nothing here is
// stored in the database — these are business constants, the same way
// ROLE_KEYS/EQUIPMENT_KEYS are code constants rather than table rows.
// GET /finance/overview echoes these back as `assumptions{}` so the
// Finance page can show where its numbers come from instead of presenting
// them as unexplained truth.
//
// ⚠️ FIXED_COST_PER_MILE is 0.75, not the 0.48 the old frontend mock used.
// See Ochiq-masalalar #3c / Qaror in the plan: at the old rate a
// realistic $2.30/mi load priced out to a 27% margin, which is roughly
// double what a real small fleet clears (5–15%). Raising this one constant
// closes that gap without touching any load's stored rate.
export const FUEL_PRICE_PER_GAL = 4.05
export const AVG_MPG = 6.5
export const FACTORING_RATE = 0.03
export const FIXED_COST_PER_MILE = 0.75
export const MONTHLY_INSURANCE = 2850

// Driver settlement deduction rules — the same four line items
// financeData.js's mock settlement builder used, now the only place they
// live.
export const FUEL_ADVANCE_RATE = 0.12
export const FUEL_ADVANCE_CAP_USD = 220
export const ESCROW_USD = 50
export const OCCUPATIONAL_INSURANCE_USD = 35
export const FUEL_CARD_FEE_USD = 12

export function getAssumptions() {
  return {
    fuelPricePerGal: FUEL_PRICE_PER_GAL,
    avgMpg: AVG_MPG,
    fixedCostPerMile: FIXED_COST_PER_MILE,
    factoringRate: FACTORING_RATE,
  }
}

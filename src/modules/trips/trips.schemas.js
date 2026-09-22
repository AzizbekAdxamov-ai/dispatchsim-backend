import { z } from 'zod'
import { AVG_MPG, FUEL_PRICE_PER_GAL } from '../finance/finance.constants.js'

// Start, up to five stops, End -- the planner's own seven rows.
export const MAX_WAYPOINTS = 7

// Defaults are this project's own figures, not another product's: MPG and
// $/gal are finance.constants.js's fleet values; the cost-per-mile and
// per-hour inputs start at 0 (the carrier's own numbers, entered by the
// dispatcher); no max speed means the road's own duration stands.
export const planTripSchema = z.object({
  waypoints: z.array(z.string().trim().min(1).max(80)).min(2).max(MAX_WAYPOINTS),
  truck: z.object({
    maxMph: z.coerce.number().min(35).max(85).nullable().default(null),
    mpg: z.coerce.number().min(3).max(15).default(AVG_MPG),
    fuelPricePerGal: z.coerce.number().min(0.5).max(15).default(FUEL_PRICE_PER_GAL),
    costPerMile: z.coerce.number().min(0).max(20).default(0),
    costPerHour: z.coerce.number().min(0).max(500).default(0),
  }).default({}),
})

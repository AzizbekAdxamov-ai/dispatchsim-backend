import { z } from 'zod'

export const driverLogParamsSchema = z.object({
  driverId: z.string().trim().min(1).max(64),
})

// 0 = today, -1 = yesterday ... back 7 days: the log a driver must be able
// to show at roadside is the current day and the previous 7 (49 CFR
// 395.8(k)(2)).
export const driverLogQuerySchema = z.object({
  day: z.coerce.number().int().min(-7).max(0).default(0),
})

// Date range in simulated days, today included. 8 is the longest window
// any HOS rule looks back over (70 hours in 8 days, 395.3(b)(2)).
export const violationsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(8).default(7),
})

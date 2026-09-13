import { z } from 'zod'

export const openSchema = z.object({
  driverId: z.string().trim().min(1).max(64),
})

export const sendSchema = z.object({
  // 4000 is driver_messages_length. Validated here so an over-long message
  // is a 400 with a reason rather than a CHECK violation with a stack.
  text: z.string().trim().min(1).max(4000),
})

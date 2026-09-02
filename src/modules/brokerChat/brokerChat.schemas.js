// Zod validation for the broker chat endpoints. `.strict()` throughout —
// an unknown key is a validation error, never silently ignored.
import { z } from 'zod'

export const conversationIdSchema = z.string().uuid()
export const postingIdSchema = z.string().uuid()

export const sendMessageSchema = z
  .object({
    // Upper bound mirrors the messages_length CHECK in migration 016 so a
    // long paste fails as a 400 here rather than a 500 from the database.
    text: z.string().trim().min(1).max(4000),
  })
  .strict()

export const agreeRateSchema = z
  .object({
    // Same band as conversations_rate in migration 016.
    rateUsd: z.coerce.number().int().min(100).max(20000),
  })
  .strict()

import { z } from 'zod'

export const checkMcSchema = z
  .object({
    // Upper bound mirrors checks_mc_len in migration 018.
    mcNumber: z.string().trim().min(1).max(32),
  })
  .strict()

import { z } from 'zod'

export const listEntriesSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    kind: z.string().max(32).optional(),
  })
  .strict()

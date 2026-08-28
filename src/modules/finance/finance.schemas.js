// Zod validation schemas for /finance/*.

import { z } from 'zod'

const INVOICE_STATUSES = ['draft', 'open', 'overdue', 'paid']

export const invoicesQuerySchema = z
  .object({
    status: z.enum(INVOICE_STATUSES).optional(),
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()

// 'INV-2026-4471' — see finance.service.js's buildInvoice for how the id
// is derived (never stored).
export const invoiceIdSchema = z.string().regex(/^INV-\d{4}-[0-9]{4,6}$/)

export const emptyQuerySchema = z.object({}).strict()

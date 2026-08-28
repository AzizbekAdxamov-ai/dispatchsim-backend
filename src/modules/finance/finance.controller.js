// HTTP layer for /finance/*. No SQL, no business logic — see
// finance.service.js. Every route is already behind requireAuth +
// requireRole('finance') (see finance.routes.js).

import { invoicesQuerySchema, invoiceIdSchema, emptyQuerySchema } from './finance.schemas.js'
import * as financeService from './finance.service.js'

export async function getOverview(req, res) {
  emptyQuerySchema.parse(req.query)
  const result = await financeService.getOverview()
  res.status(200).json(result)
}

export async function listInvoices(req, res) {
  const input = invoicesQuerySchema.parse(req.query)
  const result = await financeService.listInvoices(input)
  res.status(200).json(result)
}

export async function getInvoice(req, res) {
  const id = invoiceIdSchema.parse(req.params.id)
  const invoice = await financeService.getInvoiceById(id)
  res.status(200).json(invoice)
}

export async function listSettlements(req, res) {
  emptyQuerySchema.parse(req.query)
  const result = await financeService.listSettlements()
  res.status(200).json(result)
}

export async function listExpenses(req, res) {
  emptyQuerySchema.parse(req.query)
  const result = await financeService.listExpenses()
  res.status(200).json(result)
}

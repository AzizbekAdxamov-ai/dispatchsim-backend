// Document service: guards + PDF generation for BOL, POD and the invoice.
//
// Each document certifies an event:
//   BOL  -- the freight went ON the truck   -> dispatched_at must exist
//   POD  -- the freight came OFF the truck  -> delivered_at must exist
//   INV  -- the haul is billable            -> any load; a draft invoice for
//           an undelivered load is exactly what finance's screen shows
//
// The guards are 409s, not 404s: the load exists, the conflict is with
// paperwork that has no event behind it yet.
//
// The carrier name is the company the student runs. It used to read
// req.auth.name/company straight off the JWT -- but the token deliberately
// carries only `sub` (see lib/token.js), so auth.company and auth.name
// never existed and every document printed the '—' fallback. There is
// still no company table, so this reads users.company (falling back to
// users.name) by the request's own user id instead of inventing one.

import { AppError } from '../../lib/errors.js'
import { getCarrier as getCompanyCarrier, addressLine as carrierAddressLine } from '../carrier/carrier.repository.js'
import { documentsRepository as repo } from './documents.repository.js'
import { generateBol } from './bol.js'
import { generatePod } from './pod.js'
import { generateInvoicePdf } from './invoice.js'

// Pure: turns a users row (or null, for no auth / no matching user) into
// the carrier block the PDF prints. Split out from carrierFor so the
// company-then-name-then-dash fallback can be unit-tested without a
// database -- carrierFor itself is just "fetch the row, hand it here".
// The fallback chain is still here, one step longer and in the right
// order. 048 gave the company a row of its own; before it, the "carrier"
// on every document was whatever the signing user typed into `company`
// at registration -- so two dispatchers meant two carriers for one
// fleet. The row wins now; the user's own text is what is left if the
// database has not been migrated yet.
export function carrierFromRow(row, carrierRow = null) {
  const official = carrierRow?.name?.trim()
  const company = row?.company?.trim()
  const name = row?.name?.trim()
  return {
    name: official || company || name || '—',
    mcNumber: carrierRow?.mcNumber ?? null,
    dotNumber: carrierRow?.dotNumber ?? null,
    phone: carrierRow?.phone ?? null,
    addressLine: carrierRow ? carrierAddressLine(carrierRow) : null,
  }
}

async function carrierFor(auth) {
  if (!hooks.getCompanyCarrier) hooks.getCompanyCarrier = getCompanyCarrier
  const [row, carrierRow] = await Promise.all([
    auth?.userId ? repo.getCarrier(auth.userId) : null,
    hooks.getCompanyCarrier(),
  ])
  return carrierFromRow(row, carrierRow)
}

async function loadOr404(loadId) {
  const load = await repo.getLoadForDocument(loadId)
  if (!load) throw new AppError('LOAD_NOT_FOUND')
  return load
}

export async function getBol({ loadId, auth }) {
  const load = await loadOr404(loadId)
  if (!load.dispatchedAt) throw new AppError('LOAD_NOT_DISPATCHED')

  return generateBol({
    load,
    driver: load.driverId
      ? { name: load.driverName, cdlNumber: load.driverCdlNumber, truckId: load.truckId }
      : null,
    carrier: await carrierFor(auth),
  })
}

export async function getPod({ loadId }) {
  const load = await loadOr404(loadId)
  if (!load.deliveredAt) throw new AppError('LOAD_NOT_DELIVERED')

  return generatePod({
    load,
    driver: load.driverId ? { name: load.driverName, truckId: load.truckId } : null,
  })
}

// Invoice PDF -- the finance service computes the invoice (id, line items,
// totals) from the same repository row the screen shows, so the document
// and the screen cannot disagree.
//
// The finance getter rides on a mutable indirection (same shape as the
// repository above): ES module namespaces are read-only, and the guard
// tests substitute this hook instead of importing around the service.
export const hooks = {
  getInvoiceById: null,
  // The company's own row (048), on the same indirection and for the
  // same reason: a test about how a document is RENDERED should not need
  // a database to tell it who the company is.
  getCompanyCarrier: null,
}

export async function getInvoicePdf({ invoiceId, auth }) {
  if (!hooks.getInvoiceById) {
    const { getInvoiceById } = await import('../finance/finance.service.js')
    hooks.getInvoiceById = getInvoiceById
  }
  const invoice = await hooks.getInvoiceById(invoiceId)
  return generateInvoicePdf({ invoice, carrier: await carrierFor(auth) })
}

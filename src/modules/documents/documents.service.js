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
// The carrier name is the company the student runs. It reads the same
// identity the auth token carries (req.auth.name/company) rather than a
// settings row -- there is no company table yet, and inventing one here
// would be a second copy of a fact that does not exist.

import { AppError } from '../../lib/errors.js'
import { documentsRepository as repo } from './documents.repository.js'
import { generateBol } from './bol.js'
import { generatePod } from './pod.js'
import { generateInvoicePdf } from './invoice.js'

function carrierFor(auth) {
  return { name: auth?.company ?? auth?.name ?? '—' }
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
    carrier: carrierFor(auth),
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
}

export async function getInvoicePdf({ invoiceId }) {
  if (!hooks.getInvoiceById) {
    const { getInvoiceById } = await import('../finance/finance.service.js')
    hooks.getInvoiceById = getInvoiceById
  }
  const invoice = await hooks.getInvoiceById(invoiceId)
  return generateInvoicePdf({ invoice, carrier: carrierFor(null) })
}

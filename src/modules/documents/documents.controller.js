// HTTP layer for /documents. No SQL and no PDF code here -- guards live in
// documents.service.js, rendering in bol.js / pod.js / invoice.js.

import * as documentsService from './documents.service.js'

function sendPdf(res, pdf, filename) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(pdf)
}

export async function bolPdf(req, res) {
  const pdf = await documentsService.getBol({ loadId: req.params.loadId, auth: req.auth })
  sendPdf(res, pdf, `bol-${req.params.loadId}.pdf`)
}

export async function podPdf(req, res) {
  const pdf = await documentsService.getPod({ loadId: req.params.loadId })
  sendPdf(res, pdf, `pod-${req.params.loadId}.pdf`)
}

export async function invoicePdf(req, res) {
  // auth carries the requester's user id, which the service needs to look
  // up the carrier's company/name for the printed page (see
  // documents.service.js's carrierFor) -- omitted before, so every invoice
  // printed the '—' placeholder regardless of who was logged in.
  const pdf = await documentsService.getInvoicePdf({ invoiceId: req.params.invoiceId, auth: req.auth })
  sendPdf(res, pdf, `invoice-${req.params.invoiceId}.pdf`)
}

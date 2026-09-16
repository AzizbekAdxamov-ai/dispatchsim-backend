// Invoice PDF -- what finance sends the broker to get paid.
//
// A load IS its invoice in this codebase (no invoices table, see
// finance.service.js): line items are linehaul + accessorials, the amount
// is the same sum the tick pays against, and the id is the derived
// 'INV-<year>-<loadId>' the finance module computes. The PDF reuses that
// service rather than recomputing a second way -- a document that
// disagrees with the screen it was opened from is the exact two-copies
// failure this codebase keeps guarding against.

import {
  startDocument, formatCurrency, formatDate, formatDateTime, formatMiles,
} from './pdfShared.js'

/**
 * Generate the invoice PDF for a load.
 *
 * @param {Object} data - the object finance.service.getInvoiceById returns:
 *   { id, loadId, broker, amountUsd, paymentTerms, status, issuedAt, dueAt,
 *     lineItems: [{ label, amountUsd }], payments: [{ paidAt, amountUsd }],
 *     load: { originCity, originState, destinationCity, destinationState,
 *             distanceMi, pickupAt, deliveryAt, deliveredAt } }
 * @param {Object} data.carrier - { name }
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generateInvoicePdf({ invoice, carrier }) {
  const { doc, promise, helpers, M, RIGHT } = startDocument({
    title: 'INVOICE',
    docId: invoice.id,
    dateStr: invoice.issuedAt,
  })
    let y = 135

    // --- From / To ---
    const colW = (RIGHT - M - 20) / 2
    helpers.field('From', carrier?.name ?? '—', M, y, { width: colW })
    helpers.field('Bill to', invoice.broker, M + colW + 20, y, { width: colW })

    y += 40

    // --- Load reference line ---
    y = helpers.rule(y + 12)
    const load = invoice.load
    y = helpers.line(
      `Load #${invoice.loadId}   ·   ${load.originCity}, ${load.originState} to ${load.destinationCity}, ${load.destinationState}   ·   ${formatMiles(load.distanceMi)}`,
      M, y + 14,
    )
    y = helpers.line(
      `Picked up ${formatDateTime(load.pickupAt)}   ·   Delivered ${load.deliveredAt ? formatDateTime(load.deliveredAt) : '— not yet delivered'}`,
      M, y,
    )

    // --- Line items ---
    y = helpers.rule(y + 12)
    y = helpers.sectionLabel('LINE ITEMS', M, y + 14)

    for (const item of invoice.lineItems) {
      doc.fontSize(10).font('Helvetica').fillColor('#000000')
      doc.text(item.label, M, y, { width: RIGHT - M - 90 })
      doc.fontSize(10).font('Helvetica-Bold')
      doc.text(formatCurrency(item.amountUsd), RIGHT - 90, y, { width: 90, align: 'right' })
      y += 18
    }

    y = helpers.rule(y + 8)

    // --- Total ---
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#000000')
    doc.text('Total due', M, y + 8)
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(formatCurrency(invoice.amountUsd), RIGHT - 140, y + 6, { width: 140, align: 'right' })
    y += 34

    // --- Terms strip ---
    y = helpers.rule(y + 10)
    y = helpers.line(
      `Terms ${invoice.paymentTerms ?? 'net30'}   ·   Issued ${invoice.issuedAt ? formatDate(invoice.issuedAt) : '—'}   ·   Due ${invoice.dueAt ? formatDate(invoice.dueAt) : '—'}`,
      M, y + 14,
    )

    helpers.footer()
    doc.end()
    return promise
}

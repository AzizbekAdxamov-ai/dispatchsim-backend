// Shared PDF plumbing for the document generators.
//
// rateConfirmation.js had these inline; BOL, POD and the invoice PDF need
// the same pieces, so they live here once. Layout conventions match the
// rate confirmation: letter size, 50pt margins, Helvetica family only
// (PDFKit's built-in fonts are WinAnsi-encoded -- no arrow glyph, no box
// drawing -- so plain text separators, not unicode).
//
// Every document in this project carries a sample-document label. The disclaimer rides
// on every page of every document, generated from one constant.

import PDFDocument from 'pdfkit'

export const DISCLAIMER = 'Sample document'

// Colors. Grayscale by design: freight paperwork is printed, faxed and
// photographed at truck stops. A document that depends on color to be
// readable is a document that fails in the real workflow.
export const INK = '#000000'
export const MUTED = '#444444'
export const FAINT = '#888888'
export const RULE = '#cccccc'

export function formatCurrency(amount) {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—'
  return formatDate(dateStr) + ' ' +
    new Date(dateStr).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

export function formatWeight(lbs) {
  return `${Number(lbs ?? 0).toLocaleString()} lbs`
}

export function formatMiles(mi) {
  return `${Number(mi).toLocaleString()} mi`
}

// A new document with the disclaimer already at the top and the standard
// field() helpers attached. `chunks` collects the buffer; finish() resolves
// it. Resolving/rejecting follows rateConfirmation.js's Promise shape.
export function startDocument({ title, docId, dateStr }) {
  const doc = new PDFDocument({ size: 'letter', margin: 50 })
  const chunks = []
  const promise = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const PAGE_W = doc.page.width
  const PAGE_H = doc.page.height
  const M = 50
  const RIGHT = PAGE_W - M

  doc.fontSize(8)
    .fillColor(FAINT)
    .text(DISCLAIMER, M, 40, { align: 'center', width: PAGE_W - 2 * M })

  doc.fontSize(18)
    .fillColor(INK)
    .font('Helvetica-Bold')
    .text(title, M, 65)

  doc.fontSize(10)
    .font('Helvetica')
    .fillColor(MUTED)
    .text(`#${docId}`, M, 88)
  if (dateStr) doc.text(formatDate(dateStr), M, 100)

  const helpers = {
    // One labeled line: "Pickup    Aug 17, 2026 08:00 AM". The label is
    // muted, the value black -- scannable at a glance.
    field(label, value, x, y, { width } = {}) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(label.toUpperCase(), x, y, { width, characterSpacing: 0.5 })
      doc.fontSize(10).font('Helvetica').fillColor(INK).text(String(value ?? '—'), x, y + 11, { width })
      return y + 26
    },
    // Same pair, laid out horizontally: value on the left, muted label
    // under it. Used for the money figures a reader scans first.
    stat(value, label, x, y, { width } = {}) {
      doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text(String(value), x, y, { width })
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(String(label).toUpperCase(), x, y + 16, { width, characterSpacing: 0.5 })
      return y + 32
    },
    sectionLabel(text, x, y) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text(text, x, y)
      return y + 18
    },
    line(text, x, y, { size = 10, bold = false, color = INK, width } = {}) {
      doc.fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color).text(text, x, y, { width })
      return y + (size + 5)
    },
    rule(y) {
      doc.moveTo(M, y).lineTo(RIGHT, y).stroke(RULE)
      return y + 1
    },
    // The footer every document ends with. doc.end() stays the caller's.
    footer() {
      doc.fontSize(8)
        .fillColor(FAINT)
        .font('Helvetica')
        .text(DISCLAIMER, M, PAGE_H - 50, { align: 'center', width: PAGE_W - 2 * M })
    },
  }

  return { doc, promise, helpers, M, RIGHT, PAGE_H }
}

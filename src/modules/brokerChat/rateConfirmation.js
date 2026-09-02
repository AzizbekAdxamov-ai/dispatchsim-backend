// Rate confirmation PDF generation.
//
// Generates a one-page PDF from existing database data — no new table needed.
// The document is regenerated every time (never cached) so it always reflects
// the current state of the database.
//
// ⚠️ This is a practice document for educational purposes.
// It must look like a real rate confirmation but include a disclaimer
// that it is not a contract.

import PDFDocument from 'pdfkit'

const DISCLAIMER = 'DispatchSim — practice document, not a contract'

function formatCurrency(amount) {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Generate a rate confirmation PDF for an agreed conversation.
 *
 * @param {Object} data - Conversation + posting + broker data
 * @param {Object} data.conversation - { id, agreedRateUsd, updatedAt }
 * @param {Object} data.posting - { originCity, originState, destinationCity, destinationState,
 *   distanceMi, equipmentType, equipmentLengthFt, commodity, weightLbs, pickupAt, deliveryAt,
 *   bookedLoadId }
 * @param {Object} data.broker - { name, contactName, mcNumber, creditRating, daysToPay }
 * @param {Object} data.user - { name, company }
 * @returns {Buffer} PDF buffer
 */
export function generateRateConfirmation({ conversation, posting, broker, user }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: 50 })
    const chunks = []

    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const docId = conversation.id.slice(0, 8)
    const perMile = posting.distanceMi > 0
      ? (conversation.agreedRateUsd / posting.distanceMi).toFixed(2)
      : '—'

    // --- Disclaimer at top ---
    doc.fontSize(8)
      .fillColor('#888888')
      .text(DISCLAIMER, 50, 40, { align: 'center', width: doc.page.width - 100 })

    // --- Title ---
    doc.fontSize(18)
      .fillColor('#000000')
      .font('Helvetica-Bold')
      .text('RATE CONFIRMATION', 50, 65)

    doc.fontSize(10)
      .font('Helvetica')
      .fillColor('#444444')
      .text(`#${docId}`, 50, 88)
      .text(formatDate(conversation.updatedAt), 50, 100)

    // --- Broker / Carrier columns ---
    const leftCol = 50
    const rightCol = 320
    let y = 135

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
    doc.text('BROKER', leftCol, y)
    doc.text('CARRIER', rightCol, y)

    y += 15
    doc.fontSize(10).font('Helvetica')
    doc.text(broker.name || '—', leftCol, y)
    doc.text(user?.name || user?.company || '—', rightCol, y)

    y += 15
    doc.text(broker.contactName || '—', leftCol, y)
    doc.text('MC —', rightCol, y)

    y += 15
    doc.text(`MC ${broker.mcNumber || '—'}`, leftCol, y)

    // --- Separator ---
    y += 25
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke('#cccccc')

    // --- Load details ---
    y += 15
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
    doc.text('LOAD', leftCol, y)

    y += 18
    doc.fontSize(10).font('Helvetica')
    doc.text(`${posting.originCity}, ${posting.originState}  →  ${posting.destinationCity}, ${posting.destinationState}`, leftCol, y)

    y += 15
    doc.text(`${posting.distanceMi.toLocaleString()} mi  ·  ${posting.equipmentType} ${posting.equipmentLengthFt || '53'} ft`, leftCol, y)

    y += 15
    doc.text(`${posting.commodity || '—'}  ·  ${(posting.weightLbs || 0).toLocaleString()} lbs`, leftCol, y)

    y += 15
    doc.text(`Pickup   ${formatDateTime(posting.pickupAt)}`, leftCol, y)

    y += 15
    doc.text(`Delivery ${formatDateTime(posting.deliveryAt)}`, leftCol, y)

    // --- Separator ---
    y += 25
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke('#cccccc')

    // --- Rates ---
    y += 15
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
    doc.text('AGREED RATE', leftCol, y)

    y += 18
    doc.fontSize(14).font('Helvetica-Bold')
    doc.text(formatCurrency(conversation.agreedRateUsd), leftCol, y)

    y += 18
    doc.fontSize(10).font('Helvetica').fillColor('#444444')
    doc.text(`($${perMile}/mi)`, leftCol, y)

    y += 20
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
    doc.text(`Posted rate   ${formatCurrency(posting.rateUsd)}`, leftCol, y)

    y += 15
    doc.text(`Payment terms ${broker.daysToPay ? `net${broker.daysToPay}` : 'net30'}`, leftCol, y)

    // --- Load number ---
    y += 25
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke('#cccccc')

    y += 15
    doc.fontSize(10).font('Helvetica')
    doc.text(posting.bookedLoadId ? `Load #${posting.bookedLoadId}` : 'Load #not yet booked', leftCol, y)

    // --- Footer ---
    doc.fontSize(8)
      .fillColor('#888888')
      .font('Helvetica')
      .text(DISCLAIMER, 50, doc.page.height - 50, { align: 'center', width: doc.page.width - 100 })

    doc.end()
  })
}

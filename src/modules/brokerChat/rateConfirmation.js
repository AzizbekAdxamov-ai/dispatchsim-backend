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
import { brokerTerms, termsLines } from '../../constants/accessorials.js'

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
 * @param {Object} data.broker - { name, contactName, mcNumber, paymentTerms }
 * @param {Object} data.carrier - { name, contactName, mcNumber, dotNumber,
 *   addressLine, phone } -- the company the
 *   student runs and the person signing for it, from the users row.
 * @returns {Buffer} PDF buffer
 */
export function generateRateConfirmation({ conversation, posting, broker, carrier }) {
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

    // Both columns read the same way down: who, then who signs, then
    // the authority number. The carrier has no MC number anywhere in
    // this program -- there is no column for one and no seed that issues
    // one -- so the third line says that in words instead of printing an
    // em dash that reads as a field somebody forgot to fill in.
    y += 15
    doc.fontSize(10).font('Helvetica')
    doc.text(broker.name || '—', leftCol, y)
    doc.text(carrier?.name || '—', rightCol, y)

    y += 15
    doc.text(broker.contactName || '—', leftCol, y)
    doc.text(carrier?.contactName || '—', rightCol, y)

    y += 15
    // Not `MC ${mcNumber}` -- the stored value already starts with "MC-",
    // so that printed "MC MC-207863".
    doc.text(broker.mcNumber || 'MC —', leftCol, y)
    // The carrier's own authority (048). This line used to read "MC number
    // not issued in this program", in grey, where every real rate
    // confirmation carries the number a broker checks before they send
    // anyone a load. The company has one now, and this is where a
    // dispatcher learns to look for it.
    doc.text(carrier?.mcNumber || 'MC —', rightCol, y)

    y += 13
    doc.fontSize(8).fillColor('#666666')
    doc.text(carrier?.dotNumber ? `USDOT ${carrier.dotNumber}` : '', rightCol, y)
    y += 11
    doc.text(carrier?.addressLine ?? '', rightCol, y)
    y += 11
    doc.text(carrier?.phone ?? '', rightCol, y)
    // What the dispatcher told the broker. A line appears only when it was
    // said: no placeholder that reads as a field somebody forgot.
    for (const [label, value] of [
      ['DRIVER', carrier?.driverName],
      ['TRUCK', carrier?.truckNumber],
      ['DISPATCH EMAIL', carrier?.dispatcherEmail],
    ]) {
      if (!value) continue
      y += 11
      doc.text(`${label}  ${value}`, rightCol, y)
    }
    doc.fontSize(10).fillColor('#000000')

    // --- Separator ---
    y += 25
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke('#cccccc')

    // --- Load details ---
    y += 15
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000')
    doc.text('LOAD', leftCol, y)

    y += 18
    doc.fontSize(10).font('Helvetica')
    // No → here: PDFKit's built-in Helvetica is WinAnsi-encoded and has no
    // arrow glyph, so it came out as garbage in the file. "to" is what a
    // real rate confirmation says anyway.
    doc.text(`${posting.originCity}, ${posting.originState}  to  ${posting.destinationCity}, ${posting.destinationState}`, leftCol, y)

    y += 15
    doc.text(`${posting.distanceMi.toLocaleString()} mi  ·  ${posting.equipmentType} ${posting.equipmentLengthFt || '53'} ft`, leftCol, y)

    y += 15
    doc.text(`${posting.commodity || '—'}  ·  ${(posting.weightLbs || 0).toLocaleString()} lbs`, leftCol, y)

    // Shipper and receiver side by side, each with its appointment. The names
    // and streets are made up per posting (stops.js).
    y += 18
    const stopBlock = (title, stop, appt, x) => {
      let sy = y
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000').text(title, x, sy)
      doc.font('Helvetica').fillColor('#000000')
      for (const line of [stop?.name, stop?.street, stop ? `${stop.city}, ${stop.state}` : null, `Appt  ${formatDateTime(appt)}`]) {
        if (!line) continue
        sy += 12
        doc.fontSize(9).text(line, x, sy)
      }
      return sy
    }
    const shipperEnd = stopBlock('SHIPPER', posting.shipper, posting.pickupAt, leftCol)
    const receiverEnd = stopBlock('RECEIVER', posting.receiver, posting.deliveryAt, rightCol)
    y = Math.max(shipperEnd, receiverEnd)
    doc.fontSize(10)

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
    // The term the load will actually carry (net15/30/45/60), not the
    // broker's raw days_to_pay -- "net68" is not a payment term, and the
    // exact day count is part of what Broker Check is for. The terms
    // belong on the document: a rate confirmation states them, and a
    // dispatcher who reads this one learns how long the money will take.
    doc.text(`Payment terms ${broker.paymentTerms || 'net30'}`, leftCol, y)

    // --- Accessorials ---
    // The terms the broker quoted in the chat, from the same function
    // (src/constants/accessorials.js): what was said is what is signed.
    y += 20
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
    doc.text('ACCESSORIALS', leftCol, y)
    doc.font('Helvetica').fillColor('#444444')
    for (const line of termsLines(brokerTerms(broker.name, posting.equipmentType))) {
      y += 13
      doc.text(line, leftCol, y)
    }

    // --- Load number ---
    y += 25
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).stroke('#cccccc')

    y += 15
    doc.fontSize(10).font('Helvetica')
    doc.text(posting.bookedLoadId ? `Load #${posting.bookedLoadId}` : 'Load — not yet booked', leftCol, y)

    // --- Footer ---
    // Above the bottom margin, not on it. `page.height - 50` is exactly
    // the margin line, so an 8pt line placed there did not fit in the
    // content box and PDFKit flowed it onto a second page -- every rate
    // confirmation this program has produced was two pages, the second
    // one blank apart from this sentence. `lineBreak: false` keeps it on
    // one line whatever the text is.
    doc.fontSize(8)
      .fillColor('#888888')
      .font('Helvetica')
      .text(DISCLAIMER, 50, doc.page.height - 64, { align: 'center', width: doc.page.width - 100, lineBreak: false })

    doc.end()
  })
}

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
import { tarpFor, securementFor } from '../../constants/freightHandling.js'
import { rateQuote, SPLIT_RATE } from './rateQuote.js'
import { APP_TIMEZONE } from '../../constants/appClock.js'

const DISCLAIMER = 'Sample document'

function formatCurrency(amount) {
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

// "flatbed 48 ft  #T-552": only the parts the dispatcher said.
function trailerValue(carrier) {
  const kind = [carrier?.trailerType, carrier?.trailerLengthFt ? `${carrier.trailerLengthFt} ft` : null].filter(Boolean).join(' ')
  return [kind, carrier?.trailerNumber ? `#${carrier.trailerNumber}` : null].filter(Boolean).join('  ')
}

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { timeZone: APP_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { timeZone: APP_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit' })
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
    // Column widths: the left stops short of the right, the right runs to
    // the margin. Every line is wrapped inside its column and the next line
    // starts below the HEIGHT it actually took (put), never a fixed step --
    // a long company name or address used to run into the line under it.
    const leftW = 255
    const rightW = doc.page.width - 50 - rightCol
    // Draw text, return where the next line starts: the usual step, or the
    // wrapped height when the text took more than one line. Empty text draws
    // nothing but still takes its step, so the layout does not shift.
    const put = (text, x, yy, w, step) => {
      if (!text) return yy + step
      doc.text(text, x, yy, { width: w })
      return yy + Math.max(step, doc.heightOfString(text, { width: w }) + 2)
    }
    let y = 135

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
    doc.text('BROKER', leftCol, y)
    doc.text('CARRIER', rightCol, y)

    // Both columns read the same way down: who, then who signs, then
    // the authority number.
    y += 15
    doc.fontSize(10).font('Helvetica')
    let ly = put(broker.name || '—', leftCol, y, leftW, 15)
    let ry = put(carrier?.name || '—', rightCol, y, rightW, 15)

    ly = put(broker.contactName || '—', leftCol, ly, leftW, 15)
    ry = put(carrier?.contactName || '—', rightCol, ry, rightW, 15)

    // Not `MC ${mcNumber}` -- the stored value already starts with "MC-",
    // so that printed "MC MC-207863".
    ly = put(broker.mcNumber || 'MC —', leftCol, ly, leftW, 15)
    // The carrier's own authority (048). This line used to read "MC number
    // not issued in this program", in grey, where every real rate
    // confirmation carries the number a broker checks before they send
    // anyone a load. The company has one now, and this is where a
    // dispatcher learns to look for it.
    ry = put(carrier?.mcNumber || 'MC —', rightCol, ry, rightW, 13)

    doc.fontSize(8).fillColor('#666666')
    ry = put(carrier?.dotNumber ? `USDOT ${carrier.dotNumber}` : '', rightCol, ry, rightW, 11)
    ry = put(carrier?.addressLine ?? '', rightCol, ry, rightW, 11)
    ry = put(carrier?.phone ?? '', rightCol, ry, rightW, 11)
    // What the dispatcher told the broker. A line appears only when it was
    // said: no placeholder that reads as a field somebody forgot. When
    // "LABEL  value" is wider than the column (a long company name makes a
    // long dispatch email), the label gets its own line and the value the
    // next, so an address is never split across two lines.
    for (const [label, value] of [
      ['DRIVER', carrier?.driverName],
      ['TRUCK', carrier?.truckNumber],
      ['TRAILER', trailerValue(carrier)],
      ['DISPATCH EMAIL', carrier?.dispatcherEmail],
    ]) {
      if (!value) continue
      const line = `${label}  ${value}`
      if (doc.widthOfString(line) <= rightW) {
        ry = put(line, rightCol, ry, rightW, 11)
      } else {
        ry = put(label, rightCol, ry, rightW, 11)
        ry = put(value, rightCol, ry, rightW, 11)
      }
    }
    doc.fontSize(10).fillColor('#000000')
    // Each column's last line sits one step above where its next would go.
    y = Math.max(ly - 15, ry - 11)

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

    // Open-deck freight: what the carrier covers and ties down with.
    const tarp = tarpFor(posting)
    if (tarp && tarp.needed !== null) {
      y += 15
      doc.text(tarp.needed ? `Tarp: ${tarp.kind} required` : 'Tarp: not required', leftCol, y)
    }
    const tiedown = securementFor(posting)
    if (tiedown) {
      y += 15
      doc.text(`Securement: ${tiedown.count} ${tiedown.kind}`, leftCol, y)
    }

    // Shipper and receiver side by side, each with its appointment. The names
    // and streets are made up per posting (stops.js).
    y += 18
    const stopBlock = (title, stop, appt, x, w) => {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000').text(title, x, y)
      doc.font('Helvetica').fillColor('#000000')
      let sy = y + 12
      for (const line of [stop?.name, stop?.street, stop ? `${stop.city}, ${stop.state}` : null, `Appt  ${formatDateTime(appt)}`]) {
        if (!line) continue
        doc.fontSize(9)
        sy = put(line, x, sy, w, 12)
      }
      return sy - 12
    }
    const shipperEnd = stopBlock('SHIPPER', posting.shipper, posting.pickupAt, leftCol, leftW)
    const receiverEnd = stopBlock('RECEIVER', posting.receiver, posting.deliveryAt, rightCol, rightW)
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

    const quote = rateQuote(conversation, conversation.agreedRateUsd)
    if (quote.rateBasis === SPLIT_RATE) {
      // Print the frozen paper breakdown, not a later posting's components.
      y += 15
      doc.text(`Linehaul ${formatCurrency(quote.linehaulUsd)} + Fuel ${formatCurrency(quote.fuelSurchargeUsd)}`, leftCol, y)
    }

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
    for (const line of termsLines(brokerTerms(broker.name, posting.equipmentType, posting.commodity))) {
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

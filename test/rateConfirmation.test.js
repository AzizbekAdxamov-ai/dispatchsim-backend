// The rate confirmation PDF names both sides of the deal.
//
// This test exists because of a bug that survived every review: the
// controller passed `req.auth` as the document's `user`, and req.auth is
// only { userId }. So `user?.name || user?.company` was undefined on
// every single run, and the CARRIER column printed an em dash while the
// BROKER column printed a name, a contact and an MC number. Nothing
// threw, nothing logged, and the PDF looked plausible -- it just never
// said who the carrier was.
//
// Reading the PDF back is the only honest check here: asserting on the
// arguments would pass just as happily with the broken version. PDFKit
// writes its page content as a Flate-compressed stream of PDF operators,
// and the strings inside it are hex (`<48656c6c6f> Tj`), split into runs
// wherever kerning is applied -- so the text is recovered by inflating
// every stream and decoding every hex run in it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

import { generateRateConfirmation } from '../src/modules/brokerChat/rateConfirmation.js'
import { brokerTerms, termsLines } from '../src/constants/accessorials.js'

// Every FlateDecode stream in the file, inflated and concatenated. A
// stream that will not inflate (an embedded font, say) is skipped rather
// than failing the read -- the text is in the ones that do.
function pdfText(buffer) {
  const out = []
  let from = 0
  for (;;) {
    const start = buffer.indexOf('stream', from)
    if (start === -1) break
    let body = start + 'stream'.length
    if (buffer[body] === 0x0d) body += 1
    if (buffer[body] === 0x0a) body += 1
    const end = buffer.indexOf('endstream', body)
    if (end === -1) break
    try {
      const ops = inflateSync(buffer.subarray(body, end)).toString('latin1')
      // Each TJ array is one line, its hex runs split by kerning -- join
      // the runs inside a line, and put a newline between lines, so a
      // kerned word is still one word and two lines never run together.
      for (const line of ops.split('\n')) {
        const runs = line.match(/<([0-9A-Fa-f]+)>/g)
        if (!runs) continue
        out.push(runs.map((r) => Buffer.from(r.slice(1, -1), 'hex').toString('latin1')).join(''))
      }
    } catch {
      // not a deflate stream (an embedded font, say); no text to read
    }
    from = end + 'endstream'.length
  }
  return out.join('\n')
}

const CONVERSATION = { id: 'e1a2b3c4-d5e6-4789-8abc-def012345678', agreedRateUsd: 2840, updatedAt: '2026-09-20T15:00:00.000Z' }
const POSTING = {
  originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL',
  distanceMi: 967, equipmentType: 'dry-van', equipmentLengthFt: 53, commodity: 'Canned goods',
  weightLbs: 42000, pickupAt: '2026-09-21T08:00:00.000Z', deliveryAt: '2026-09-23T08:00:00.000Z',
  bookedLoadId: '600123', rateUsd: 2900,
}
const BROKER = { name: 'Redline Freight Services', contactName: 'Dana Whitfield', mcNumber: 'MC-207863', paymentTerms: 'Net 30' }
const CARRIER = { name: 'Northgate Carriers LLC', contactName: 'Azizbek Adxamov' }

test('the carrier column carries the carrier, not an em dash', async () => {
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: CARRIER,
  }))

  // Kills: the `user: req.auth` wiring coming back, and any rename that
  // drops the carrier fields on the way from the query to the page.
  assert.ok(text.includes('Northgate Carriers LLC'), 'the carrier company is not on the page')
  assert.ok(text.includes('Azizbek Adxamov'), 'the person signing for the carrier is not on the page')

  // The broker side must still be intact -- this document is a
  // two-column comparison and half of it is not an improvement.
  assert.ok(text.includes('Redline Freight Services'))
  assert.ok(text.includes('Dana Whitfield'))
  assert.ok(text.includes('MC-207863'))
})

test('the carrier prints its own authority, not an excuse for not having one', async () => {
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER,
    carrier: { ...CARRIER, mcNumber: 'MC-741309', dotNumber: '3947182',
      addressLine: '4120 Empire Central Drive, Dallas, TX 75247', phone: '214-555-0110' },
  }))
  // Kills: the line this replaced -- "MC number not issued in this
  // program", printed in grey where a broker looks for the number that
  // decides whether they send you a load (048 gave the company one).
  assert.ok(!text.includes('not issued in this program'), 'the old excuse is gone')
  assert.ok(text.includes('MC-741309'), "the carrier's MC is on the paper")
  assert.ok(text.includes('USDOT 3947182'))
  assert.ok(text.includes('214-555-0110'))
  // And the broker's number is still there: two columns, two authorities.
  assert.ok(text.includes('MC-207863'))
})

test('a carrier with no company name degrades to an em dash, it does not crash', async () => {
  // An account can legitimately have an empty `company` (users.company
  // defaults to ''). The document still has to render.
  const buf = await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: { name: '', contactName: 'Azizbek Adxamov' },
  })
  assert.ok(buf.length > 1000, 'no PDF came out')
  assert.ok(pdfText(buf).includes('Azizbek Adxamov'))
})

test('the document is one page', async () => {
  // It was two. The disclaimer was placed at `page.height - 50`, which
  // is the bottom margin itself, so its line did not fit inside the
  // content box and PDFKit started a new page for it -- every rate
  // confirmation printed a second sheet that was blank apart from one
  // grey sentence, and nobody noticed because the first page was right.
  //
  // Kills: the footer drifting back down onto (or past) the margin.
  const buf = await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: CARRIER,
  })
  const pages = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
  assert.equal(pages, 1, `the rate confirmation came out ${pages} pages`)
})

test('the practice disclaimer is on the page', async () => {
  // Not decoration: this document is designed to look like the real
  // thing, so the sentence that says it is not one has to survive every
  // edit to the layout.
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: CARRIER,
  }))
  assert.ok(text.includes('practice document, not a contract'))
})

// Kills: a rate confirmation without the broker's terms, or with terms
// from somewhere other than the function the chat quotes from. What the
// broker said in the thread is what is on the paper.
test('the paper carries the same accessorial terms the broker quotes', async () => {
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: CARRIER,
  }))
  assert.ok(text.includes('ACCESSORIALS'), 'no accessorials section')
  for (const line of termsLines(brokerTerms(BROKER.name, POSTING.equipmentType))) {
    assert.ok(text.includes(line), `missing: ${line}`)
  }
})

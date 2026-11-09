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

import { generateRateConfirmation } from '../src/modules/brokerChat/rateConfirmation.js'
import { brokerTerms, termsLines } from '../src/constants/accessorials.js'
import { pdfText } from './helpers/pdfText.js'

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

test('the sample-document label is on the page', async () => {
  // Not decoration: this document is designed to look like the real
  // thing, so the sentence that says it is not one has to survive every
  // edit to the layout.
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: POSTING, broker: BROKER, carrier: CARRIER,
  }))
  assert.ok(text.includes('Sample document'))
  assert.ok(!/practice|DispatchSim/i.test(text))
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

// -- Booking-call fields (2026-10-17) -----------------------------------------

import { stopsFor } from '../src/modules/brokerChat/stops.js'

const STOPS = stopsFor({ id: 'p-1', ...POSTING })
const TOLD = { driverName: 'Grace Lindqvist', truckNumber: 'RS-9278-CY', dispatcherEmail: 'dispatch@cedar-ridge.example' }

// Kills: shipper, receiver or the details the dispatcher gave missing from the paper
test('the paper carries shipper, receiver, appointments, driver, truck and email', async () => {
  const buf = await generateRateConfirmation({
    conversation: CONVERSATION, posting: { ...POSTING, ...STOPS }, broker: BROKER, carrier: { ...CARRIER, mcNumber: 'MC-741309', ...TOLD },
  })
  const text = pdfText(buf)
  for (const s of [STOPS.shipper, STOPS.receiver]) {
    assert.ok(text.includes(s.name), s.name)
    assert.ok(text.includes(s.street), s.street)
    assert.ok(text.includes(`${s.city}, ${s.state}`))
  }
  assert.ok(text.includes('SHIPPER') && text.includes('RECEIVER'))
  assert.ok(text.includes('Appt'))
  for (const v of ['Grace Lindqvist', 'RS-9278-CY', 'dispatch@cedar-ridge.example', 'MC-741309']) assert.ok(text.includes(v), v)
  // Kills: all the new fields pushing the footer onto a second page
  const pages = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
  assert.equal(pages, 1, `the rate confirmation came out ${pages} pages`)
})

// Kills: dropping the TRAILER line -- the paper named the driver and truck but not the trailer
test('the paper carries the trailer type, length and number the dispatcher gave', async () => {
  const buf = await generateRateConfirmation({
    conversation: CONVERSATION, posting: { ...POSTING, ...STOPS }, broker: BROKER,
    carrier: { ...CARRIER, mcNumber: 'MC-741309', ...TOLD, trailerNumber: 'T-552', trailerType: 'flatbed', trailerLengthFt: 48 },
  })
  const text = pdfText(buf)
  assert.ok(text.includes('TRAILER'), 'TRAILER label')
  assert.ok(text.includes('T-552') && text.includes('flatbed 48 ft'))
  assert.equal((buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length, 1)
})

// Kills: handling lines missing from an open-deck paper (live: copper tubing flatbed named no tarp or tiedowns)
test('an open-deck paper states the tarp and the securement; a dry van states neither', async () => {
  const make = (posting) => generateRateConfirmation({ conversation: CONVERSATION, posting: { ...POSTING, ...STOPS, ...posting }, broker: BROKER, carrier: CARRIER })
  const flat = pdfText(await make({ equipmentType: 'flatbed', commodity: 'Copper tubing', weightLbs: 40000 }))
  assert.ok(flat.includes('Tarp: steel tarps (4 ft drop) required'))
  assert.match(flat, /Securement: \d+ straps/)
  assert.match(flat, /Tarp pay: \$\d+ per load/)
  const bare = pdfText(await make({ equipmentType: 'flatbed', commodity: 'Concrete pipe', weightLbs: 40000 }))
  assert.ok(bare.includes('Tarp: not required'))
  const van = pdfText(await make({ equipmentType: 'dry-van' }))
  assert.ok(!van.includes('Tarp:') && !van.includes('Securement:'))
})

// Kills: a placeholder printed for what was never said
test('driver, truck and email lines are absent when they were not said', async () => {
  const text = pdfText(await generateRateConfirmation({
    conversation: CONVERSATION, posting: { ...POSTING, ...STOPS }, broker: BROKER, carrier: { ...CARRIER, dispatcherEmail: null },
  }))
  assert.ok(!text.includes('DISPATCH EMAIL'))
  assert.ok(!text.includes('DRIVER'))
  assert.ok(!text.includes('TRUCK'))
})

// Kills: a long company name making the dispatch email wrap mid-address and
// run into the line under it (the told lines used a fixed 11pt step)
test('a long carrier name keeps the dispatch email whole and the page single', async () => {
  const email = 'dispatch@cedar-ridge-transport-services-of-north-texas.example'
  const buf = await generateRateConfirmation({
    conversation: CONVERSATION, posting: { ...POSTING, ...STOPS }, broker: BROKER,
    carrier: {
      name: 'Cedar Ridge Transport Services of North Texas Incorporated', contactName: 'Azizbek Adxamov',
      mcNumber: 'MC-741309', dotNumber: '3456789', phone: '(555) 010-0199',
      addressLine: '100 Main St, Suite 400, Dallas, TX 75201', ...TOLD, dispatcherEmail: email,
    },
  })
  const text = pdfText(buf)
  assert.ok(text.includes(email), 'the email was split')
  assert.ok(text.includes('DISPATCH EMAIL'))
  for (const v of ['Grace Lindqvist', 'RS-9278-CY', STOPS.shipper.name, 'MC-741309']) assert.ok(text.includes(v), v)
  const pages = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
  assert.equal(pages, 1)
})

// Documents: BOL, POD, invoice PDF.
//
// The generators run pdfkit in-process and produce real buffers, so the
// tests can assert on the PDF's own text: a document whose "Delivered at"
// line prints 'Invalid Date' is worse than no document. Each test names
// the mutation it kills.
//
// The guards are the real product: paperwork certifies an event, and a
// document generated for an event that never happened is a lie with a
// letterhead. sql-check parses documents.sql.js; the service-level guards
// (LOAD_NOT_DISPATCHED / LOAD_NOT_DELIVERED) are tested here directly
// against the repository's return shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { generateBol } from '../src/modules/documents/bol.js'
import { generatePod } from '../src/modules/documents/pod.js'
import { generateInvoicePdf } from '../src/modules/documents/invoice.js'
import { getBol, getPod, getInvoicePdf, carrierFromRow } from '../src/modules/documents/documents.service.js'
import { documentsRepository as repo } from '../src/modules/documents/documents.repository.js'

// Pull the readable text back out of a generated PDF. pdfkit compresses
// its content streams (Flate) and writes text as WinAnsi hex strings, so
// raw greps find nothing: inflate the streams first, then decode every
// <hex> run. Words are joined with a space-free separator because pdfkit
// splits a line across several TJ runs -- 'Bagged r' + 'ice' -- and a
// test asserting on the JOINED text would only pass by luck.
function pdfText(buffer) {
  let content = ''
  for (const s of buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { content += zlib.inflateSync(Buffer.from(s[1], 'latin1')).toString('latin1') } catch { content += s[1] }
  }
  return [...content.matchAll(/<([0-9A-Fa-f]+)>/g)]
    .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
    .join('')
}

// startDocument() (pdfShared.js) prints the disclaimer once at the TOP of
// every document unconditionally, before the generator's own code runs --
// so a plain `text.includes('Sample document')` can never fail: the
// header copy survives even if a generator's own helpers.footer() call
// (the bottom copy) is dropped. Counting occurrences is what actually
// pins the footer call down; this is what the BOL test's simple
// `.includes` missed, and what let POD and Invoice ship with no check on
// their footer call at all.
function disclaimerCount(text) {
  return (text.match(/Sample document/g) ?? []).length
}

const LOAD = {
  id: '4471',
  originCity: 'Dallas', originState: 'TX',
  destinationCity: 'Chicago', destinationState: 'IL',
  broker: 'Harbor Line Freight Exchange',
  commodity: 'Bagged rice',
  weightLbs: 38000,
  equipmentType: 'dry-van', equipmentLengthFt: 53,
  distanceMi: 920,
  pickupAt: '2026-09-16T08:00:00Z',
  deliveryAt: '2026-09-17T14:00:00Z',
  dispatchedAt: '2026-09-16T09:00:00Z',
  deliveredAt: '2026-09-16T15:30:00Z',
  paymentTerms: 'net30',
  driverId: 'd12', driverName: 'Earl Simmons', driverCdlNumber: 'CDL4471', truckId: 'TX-4471-TX',
}

const DRIVER = { name: 'Earl Simmons', cdlNumber: 'CDL4471', truckId: 'TX-4471-TX' }
const CARRIER = { name: 'Adxamov Logistics' }

test('BOL: one page, correct title, freight and parties on the page', async () => {
  const pdf = await generateBol({ load: LOAD, driver: DRIVER, carrier: CARRIER })
  const text = pdfText(pdf)

  assert.ok(text.includes('BILL OF LADING'), 'title missing')
  assert.ok(text.includes('Bagged rice'), 'commodity missing')
  assert.ok(text.includes('38,000 lbs'), 'weight not formatted')
  assert.ok(text.includes('920 mi'), 'miles missing')
  assert.ok(text.includes('Earl Simmons'), 'driver missing')
  assert.ok(text.includes('Adxamov Logistics'), 'carrier missing')
  assert.ok(text.includes('net30'), 'payment terms missing')
  // The disclaimer rides on every document -- once from
  // startDocument()'s header, once from this generator's own
  // helpers.footer() call. THE MUTATION: `.includes` alone can't tell the
  // footer call apart from just the header, because the header's copy
  // survives on its own; the count is what actually depends on
  // helpers.footer() having run.
  assert.equal(disclaimerCount(text), 2, 'disclaimer missing (expected header + footer)')
  assert.ok(!/practice document/i.test(text), 'old practice wording is back')
  // A real date, never 'Invalid Date'.
  assert.ok(!text.includes('Invalid Date'), 'an Invalid Date leaked onto the page')
})

test('BOL: undated fields render as em dash, not Invalid Date', async () => {
  // THE MUTATION: a missing pickupAt pushed through new Date() prints the
  // literal string 'Invalid Date' on shipped paper.
  const pdf = await generateBol({
    load: { ...LOAD, pickupAt: null, deliveryAt: null },
    driver: DRIVER, carrier: CARRIER,
  })
  assert.ok(!pdfText(pdf).includes('Invalid Date'))
})

test('POD: delivered facts and a blank signature line', async () => {
  const pdf = await generatePod({ load: LOAD, driver: { name: DRIVER.name, truckId: DRIVER.truckId } })
  const text = pdfText(pdf)

  assert.ok(text.includes('PROOF OF DELIVERY'), 'title missing')
  assert.ok(text.includes('Received in good order by'), 'signature block missing')
  assert.ok(text.includes('X ___'), 'blank signature line missing -- a POD without a receiver signature block is forged paper')
  assert.ok(text.includes('Delivered by  Earl Simmons'), 'driver missing')
  assert.ok(!text.includes('Invalid Date'))
  // THE MUTATION: dropping the helpers.footer() call in pod.js still
  // produces a valid-looking PDF -- the BOL test's `.includes` check
  // would have missed this too (see disclaimerCount's comment above), and
  // nothing checked POD's own footer call at all. Counting catches it:
  // one copy from the header is not the same as header + footer.
  assert.equal(disclaimerCount(text), 2, 'disclaimer missing (expected header + footer)')
  assert.ok(!/practice document/i.test(text), 'old practice wording is back')
})

test('Invoice PDF: line items sum to the printed total', async () => {
  const invoice = {
    id: 'INV-2026-4471',
    loadId: '4471',
    broker: LOAD.broker,
    amountUsd: 1550,
    paymentTerms: 'net30',
    status: 'open',
    issuedAt: LOAD.deliveredAt,
    dueAt: '2026-10-16T15:30:00Z',
    lineItems: [
      { label: 'Linehaul', amountUsd: 1450 },
      { label: 'Detention 2h', amountUsd: 100 },
    ],
    payments: [],
    load: LOAD,
  }
  const pdf = await generateInvoicePdf({ invoice, carrier: CARRIER })
  const text = pdfText(pdf)

  assert.ok(text.includes('INVOICE'), 'title missing')
  assert.ok(text.includes('INV-2026-4471'), 'invoice id missing')
  assert.ok(text.includes('Linehaul'), 'line item missing')
  assert.ok(text.includes('Detention 2h'), 'accessorial missing')
  assert.ok(text.includes('$1,550'), 'total not formatted with separators')
  assert.ok(!text.includes('Invalid Date'))
  // THE MUTATION: same gap as the POD test above -- dropping
  // helpers.footer() from invoice.js shipped unnoticed too, since nothing
  // checked its footer call and a plain `.includes` can't tell the header
  // copy from header + footer.
  assert.equal(disclaimerCount(text), 2, 'disclaimer missing (expected header + footer)')
  assert.ok(!/practice document/i.test(text), 'old practice wording is back')
})

// --- Service guards ---

test('BOL guard: refusing an undispatched load with LOAD_NOT_DISPATCHED', async () => {
  // THE MUTATION: dropping the guard lets a student carry paperwork for a
  // run that never happened -- a BOL for freight still sitting on the dock.
  const original = repo.getLoadForDocument
  repo.getLoadForDocument = async () => ({ ...LOAD, dispatchedAt: null })
  try {
    await assert.rejects(
      () => getBol({ loadId: '4471', auth: { company: 'x' } }),
      (err) => err.code === 'LOAD_NOT_DISPATCHED' && err.status === 409,
    )
  } finally {
    repo.getLoadForDocument = original
  }
})

test('POD guard: refusing an undelivered load with LOAD_NOT_DELIVERED', async () => {
  const original = repo.getLoadForDocument
  repo.getLoadForDocument = async () => ({ ...LOAD, deliveredAt: null })
  try {
    await assert.rejects(
      () => getPod({ loadId: '4471' }),
      (err) => err.code === 'LOAD_NOT_DELIVERED' && err.status === 409,
    )
  } finally {
    repo.getLoadForDocument = original
  }
})

test('BOL/POD: unknown load is LOAD_NOT_FOUND, not a crash', async () => {
  const original = repo.getLoadForDocument
  repo.getLoadForDocument = async () => null
  try {
    await assert.rejects(() => getBol({ loadId: '9999' }), (err) => err.code === 'LOAD_NOT_FOUND')
    await assert.rejects(() => getPod({ loadId: '9999' }), (err) => err.code === 'LOAD_NOT_FOUND')
  } finally {
    repo.getLoadForDocument = original
  }
})

test('invoice PDF service: reuses finance.getInvoiceById, no second math', async () => {
  // THE MUTATION: recomputing the invoice in the documents module would
  // let the paper disagree with the finance screen. The service delegates
  // through hooks.getInvoiceById -- pinned here with a stub that returns
  // finance's own buildInvoice shape, so the test asserts the DELEGATION
  // and the rendering, not the database.
  const { hooks } = await import('../src/modules/documents/documents.service.js')
  const original = hooks.getInvoiceById
  const originalCarrier = hooks.getCompanyCarrier
  // The company's row, stubbed for the same reason as the invoice: this
  // test is about the paper, not about the database behind the name.
  hooks.getCompanyCarrier = async () => ({
    name: 'Keystone Line Haul', mcNumber: 'MC-741309', dotNumber: '3947182',
    phone: '214-555-0110', addressLine: '4120 Empire Central Drive',
    city: 'Dallas', state: 'TX', postalCode: '75247',
  })
  hooks.getInvoiceById = async () => ({
    id: 'INV-2026-4471',
    loadId: '4471',
    broker: LOAD.broker,
    amountUsd: 1550,
    paymentTerms: 'net30',
    status: 'open',
    issuedAt: LOAD.deliveredAt,
    dueAt: '2026-10-16T15:30:00Z',
    lineItems: [
      { label: 'Linehaul', amountUsd: 1450 },
      { label: 'Detention 2h', amountUsd: 100 },
    ],
    payments: [],
    load: LOAD,
  })
  try {
    const pdf = await getInvoicePdf({ invoiceId: 'INV-2026-4471' })
    assert.ok(Buffer.isBuffer(pdf))
    assert.ok(pdf.length > 500, 'suspiciously small PDF')
    const text = pdfText(pdf)
    assert.ok(text.includes('INV-2026-4471'))
    assert.ok(text.includes('$1,550'))
    // Kills: the invoice naming the carrier after whoever asked for the
    // PDF. 048 gave the company one name, and this is the paper that
    // asks a broker to pay it.
    assert.ok(text.includes('Keystone Line Haul'))
  } finally {
    hooks.getInvoiceById = original
    hooks.getCompanyCarrier = originalCarrier
  }
})

// --- carrierFor's pure fallback logic ---
//
// req.auth only ever carries { userId } (see requireAuth.js / lib/token.js --
// the token deliberately never carries role or company). carrierFor() fetches
// the user row by that id and hands it to carrierFromRow(), which is what's
// tested here directly, without a database: company (schema default '' per
// migration 001, not NULL) then name then the dash, same order the printed
// paperwork has always fallen back through.

// 048 put the company's own row above both of these. Kills: leaving the
// document to name the carrier after whoever happens to be signing it --
// two dispatchers with two spellings of the company meant two carriers
// for one fleet.
test('carrierFromRow: the company row wins over anything a person typed', () => {
  const official = { name: 'Keystone Line Haul', mcNumber: 'MC-741309', dotNumber: '3947182', phone: '214-555-0110', addressLine: '4120 Empire Central Drive', city: 'Dallas', state: 'TX', postalCode: '75247' }
  const out = carrierFromRow({ company: 'Adxamov Logistics', name: 'Azizbek Adxamov' }, official)
  assert.equal(out.name, 'Keystone Line Haul')
  assert.equal(out.mcNumber, 'MC-741309')
  assert.equal(out.addressLine, '4120 Empire Central Drive, Dallas, TX 75247')
})

test('carrierFromRow: a filled-in company wins when there is no company row', () => {
  assert.equal(
    carrierFromRow({ company: 'Adxamov Logistics', name: 'Azizbek Adxamov' }).name,
    'Adxamov Logistics',
  )
})

test('carrierFromRow: an empty company falls back to the user\'s name', () => {
  // THE MUTATION: company defaults to '' (migration 001's `DEFAULT ''`),
  // not NULL -- a check for `row.company == null` alone would print an
  // empty carrier line for every fresh account instead of falling through
  // to name.
  assert.equal(carrierFromRow({ company: '', name: 'Azizbek Adxamov' }).name, 'Azizbek Adxamov')
  // Whitespace-only counts as empty too.
  assert.equal(carrierFromRow({ company: '   ', name: 'Azizbek Adxamov' }).name, 'Azizbek Adxamov')
})

test('carrierFromRow: no company and no row at all fall back to the dash', () => {
  assert.equal(carrierFromRow({ company: '', name: '' }).name, '—')
  // No row -- no auth (an unauthenticated caller reached this point) or no
  // matching user id.
  assert.equal(carrierFromRow(null).name, '—')
})

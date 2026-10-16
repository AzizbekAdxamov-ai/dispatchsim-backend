// What the dispatcher told the broker on the way to a booking, read by code
// (src/modules/brokerChat/bookingTalk.js). Azizbek's decisions, 2026-10-17:
// a wrong or missing MC means no booking; nothing told is asked again.
// No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bookingFacts, saysBooked, asksMc, MC_REJECT } from '../src/modules/brokerChat/bookingTalk.js'
import { equipmentIn } from '../src/modules/brokerChat/rateTalk.js'

const carrier = { name: 'Cedar Ridge Transport Services', mcNumber: 'MC-741309' }
const now = new Date('2026-10-17T15:00:00Z')
const posting = {
  id: 'p1', originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL',
  equipmentType: 'dry-van', equipmentLengthFt: 53, weightLbs: 30000, rateUsd: 2400, distanceMi: 967,
  pickupAt: '2026-10-19T14:00:00Z',
}
const facts = (texts, extra = {}) => bookingFacts({ texts, carrier, posting, now, ...extra })

// Kills: the right MC not recognised as the carrier's
test('the right MC in the carrier\'s own format matches', () => {
  const f = facts(['MC 741309'])
  assert.equal(f.mc.said, '741309')
  assert.equal(f.mc.verdict, 'match')
})

// Kills: a wrong MC accepted
test('a wrong MC is a mismatch', () => {
  const f = facts(['MC 999999'])
  assert.equal(f.mc.said, '999999')
  assert.equal(f.mc.verdict, 'mismatch')
})

// Kills: a verdict invented when no MC was said
test('no MC said: no verdict, MC first in missing', () => {
  const f = facts(['hey, still available?'])
  assert.equal(f.mc.said, null)
  assert.equal(f.mc.verdict, null)
  assert.equal(f.missing[0], 'mc')
})

// Kills: one MC format read and the others missed
test('MC-741309, mc#741309, mc: 741309 and "MC number 741309" all read', () => {
  for (const t of ['MC-741309', 'my mc#741309', 'mc: 741309', 'MC number 741309', 'MC 0741309']) {
    assert.equal(facts([t]).mc.verdict, 'match', t)
  }
})

// Kills: a bare number refused when it is the whole message
test('digits alone as the whole message are the MC', () => {
  assert.equal(facts(['741309']).mc.verdict, 'match')
  assert.equal(facts(['  #741309 ']).mc.verdict, 'match')
})

// Kills: a rate or a truck number read as an MC
test('bare digits inside a sentence are never an MC', () => {
  for (const t of ['can you do 123456?', 'need $412,345 on it', 'truck 741309 is ready', 'rate 741309 or i walk']) {
    assert.equal(facts([t]).mc.said, null, t)
  }
})

// Kills: a DOT number taken for the MC
test('a DOT number is not the MC', () => {
  assert.equal(facts(['usdot 1234567']).mc.said, null)
  assert.equal(facts(['dot 741309']).mc.said, null)
})

// Kills: the oldest MC winning over a correction
test('a newer MC replaces an older one', () => {
  const f = facts(['MC 999999', 'sorry typo, MC 741309'])
  assert.equal(f.mc.verdict, 'match')
  assert.equal(facts(['MC 741309', 'MC 999999']).mc.verdict, 'mismatch')
})

// Kills: the company name not read from the introduction
test('the S9a opener gives the company, and it matches', () => {
  const f = facts(['hey this is Aziz with Cedar Ridge Transport Services, calling about your Dallas-Chicago load, still available?'])
  assert.equal(f.company, 'Cedar Ridge Transport Services')
  assert.equal(f.companyMatches, true)
  assert.equal(f.missing.includes('company'), false)
})

// Kills: a different company name accepted as the carrier
test('a name that is not ours does not match', () => {
  const f = facts(['this is Mike with Blue Harbor Freight LLC, calling about the load'])
  assert.equal(f.company, 'Blue Harbor Freight LLC')
  assert.equal(f.companyMatches, false)
})

// Kills: LLC / Inc / case blocking a match
test('suffixes and case do not matter; a short form is contained', () => {
  assert.equal(facts(['this is Aziz with CEDAR RIDGE TRANSPORT SERVICES inc.']).companyMatches, true)
  assert.equal(facts(['aziz here from cedar ridge transport']).companyMatches, true)
})

// Kills: "with a 53 dry van" or "from dallas" read as a company
test('"with ..." and "from ..." outside an introduction are not a company', () => {
  assert.equal(facts(["i'm empty with a 53 dry van"]).company, null)
  assert.equal(facts(['going from dallas to chicago']).company, null)
  assert.equal(facts(['hey, still available?']).companyMatches, null)
})

// Kills: the truck's place and empty time not read from the S9a line
test("S9a line 3: truck's in Dallas, empty tomorrow 6am, 53 dry van", () => {
  const f = facts(["truck's in Dallas, empty tomorrow 6am, 53 dry van"])
  assert.equal(f.truck.city, 'Dallas')
  assert.equal(f.emptyAt, 'empty tomorrow 6am')
  assert.equal(f.trailer.type, 'dry-van')
  assert.equal(f.trailer.lengthFt, 53)
  assert.equal(f.trailer.fits, true)
  for (const key of ['location', 'emptyAt', 'trailer']) assert.equal(f.missing.includes(key), false, key)
})

// Kills: a reefer accepted for a dry-van load
test('the wrong trailer type does not fit', () => {
  assert.equal(facts(['53 reefer']).trailer.fits, false)
  assert.equal(facts(['no trailer said']).trailer.fits, null)
})

// Kills: "53 miles" or a rate read as the trailer length
test('48 or 53 count as a length only next to a unit or a trailer word', () => {
  assert.equal(facts(['about 53 miles out']).trailer.lengthFt, null)
  assert.equal(facts(["53' dry van"]).trailer.lengthFt, 53)
  assert.equal(facts(['48 ft flatbed']).trailer.lengthFt, 48)
})

// Kills: step-deck read as a plain flatbed
test('equipmentIn knows step-deck before flatbed', () => {
  assert.equal(equipmentIn('step deck, 48'), 'step-deck')
  assert.equal(equipmentIn('flatbed'), 'flatbed')
  assert.equal(equipmentIn('nothing here'), null)
})

// Kills: driver name, truck number and email not read from the S9a closer
test('S9a line 6: driver, truck number and email', () => {
  const f = facts(['ok book it. driver Grace Lindqvist, truck RS-9278-CY, send the rc to dispatch@cedar-ridge.example'])
  assert.equal(f.driverName, 'Grace Lindqvist')
  assert.equal(f.truckNumber, 'RS-9278-CY')
  assert.equal(f.email, 'dispatch@cedar-ridge.example')
  for (const key of ['driverName', 'truckNumber', 'email']) assert.equal(f.missing.includes(key), false, key)
})

// Kills: "driver is in dallas" read as a driver called "In Dallas"
test('a driver name needs a name, not a verb or a place', () => {
  assert.equal(facts(['driver is in dallas']).driverName, null)
  assert.equal(facts(['driver can make it']).driverName, null)
  assert.equal(facts(['driver name is Grace Lindqvist']).driverName, 'Grace Lindqvist')
})

// Kills: a length like 53' or a mileage taken for the truck number
test('a truck number needs a digit and is not a length or a distance', () => {
  assert.equal(facts(['truck is ready']).truckNumber, null)
  assert.equal(facts(["truck 53' dry van"]).truckNumber, null)
  assert.equal(facts(['unit 4412']).truckNumber, '4412')
})

// Kills: missing keys out of order for a close pickup or an open deck
test('missing: MC and company first; location first when the pickup is hours away; trailer first for an open deck', () => {
  assert.deepEqual(facts(['hi']).missing, ['mc', 'company', 'location', 'emptyAt', 'trailer', 'driverName', 'truckNumber', 'email'])
  const flat = { ...posting, equipmentType: 'flatbed' }
  assert.deepEqual(bookingFacts({ texts: ['hi'], carrier, posting: flat, now }).missing.slice(2, 5), ['trailer', 'location', 'emptyAt'])
  const soon = { ...flat, pickupAt: '2026-10-17T20:00:00Z' }
  assert.deepEqual(bookingFacts({ texts: ['hi'], carrier, posting: soon, now }).missing.slice(2, 5), ['location', 'emptyAt', 'trailer'])
})

// Kills: a thing already told still listed as missing
test('everything told leaves nothing missing', () => {
  const f = facts([
    'this is Aziz with Cedar Ridge Transport Services, calling about your Dallas-Chicago load',
    'MC 741309',
    "truck's in Dallas, empty tomorrow 6am, 53 dry van",
    'driver Grace Lindqvist, truck RS-9278-CY, send the rc to dispatch@cedar-ridge.example',
  ])
  assert.deepEqual(f.missing, [])
})

// Kills: "booked" wording not caught
test('saysBooked catches booked / you are set / rate con coming', () => {
  for (const r of ["You're booked.", "You're all set, rate con is on its way.", "It's yours.", 'Sending over the rate con now.']) assert.equal(saysBooked(r), true, r)
  assert.equal(saysBooked('I need your MC before I book anything.'), false)
})

// Kills: MC_REJECT / asksMc missing the broker's wording
test('MC_REJECT and asksMc', () => {
  assert.match("That MC doesn't come up on my end.", MC_REJECT)
  assert.equal(asksMc("What's your MC?"), true)
  assert.equal(asksMc('Got it, thanks.'), false)
})


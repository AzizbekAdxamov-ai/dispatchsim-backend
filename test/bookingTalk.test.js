// What the dispatcher told the broker on the way to a booking, read by code
// (src/modules/brokerChat/bookingTalk.js). Azizbek's decisions, 2026-10-17:
// a wrong or missing MC means no booking; nothing told is asked again.
// No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bookingFacts, saysBooked, asksMc, MC_REJECT, confirmsUnknownBooking, NO_BOOKING_LINE,
} from '../src/modules/brokerChat/bookingTalk.js'
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


// -- The booking gate -----------------------------------------------------

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { carrierNotVerified } from '../src/modules/brokerChat/bookingTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { ERROR_CODES } from '../src/lib/errors.js'

// Kills: a verified MC blocked
test('gate: a matching MC passes', () => {
  assert.equal(carrierNotVerified({ booking: facts(['MC 741309']), contactName: 'Devin' }), null)
})

// Kills: a wrong MC allowed to agree / sign, or a silent refusal
test('gate: a wrong MC is refused in the broker\'s own sentence', () => {
  const r = carrierNotVerified({ booking: facts(['MC 999999']), contactName: 'Devin' })
  assert.equal(r.reason, 'mc-mismatch')
  assert.match(r.message, /^Devin: "That MC doesn't come up on my end/)
})

// Kills: no MC at all allowed to book
test('gate: no MC is refused and says what is needed', () => {
  const r = carrierNotVerified({ booking: facts(['just book it']), contactName: 'Devin' })
  assert.equal(r.reason, 'mc-missing')
  assert.match(r.message, /I still need your MC/)
})

// Kills: the error code missing from the catalog or from the public-details list
test('CARRIER_NOT_VERIFIED is a 409 whose details reach the screen', () => {
  assert.equal(ERROR_CODES.CARRIER_NOT_VERIFIED.status, 409)
  const handler = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'middleware', 'errorHandler.js'), 'utf8')
  assert.match(handler, /'CARRIER_NOT_VERIFIED'/)
})

// Kills: the gate called in only one of the two places that book
test('the service checks the carrier in agreeRate and in acceptRateCon', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'brokerChat', 'brokerChat.service.js'), 'utf8')
  const agree = src.slice(src.indexOf('export async function agreeRate'), src.indexOf('export async function acceptRateCon'))
  const accept = src.slice(src.indexOf('export async function acceptRateCon'), src.indexOf('export async function listConversations'))
  assert.match(agree, /await assertCarrierVerified\(conversationId, posting, deps\)/)
  assert.match(accept, /await assertCarrierVerified\(conversationId, posting, deps\)/)
  // not on the idempotent already-booked path
  assert.ok(accept.indexOf('alreadyAccepted: true') < accept.indexOf('assertCarrierVerified'))
})

// Kills: "you're booked" let through when the MC is missing or wrong
test('a reply that books without a verified MC is a problem; with one it is not', () => {
  const reply = "You're all set, sending the rate con over now."
  assert.equal(brokerReplyProblem(reply, { booking: facts(['MC 999999']) }).why, 'told them it is booked without a verified MC')
  assert.equal(brokerReplyProblem(reply, { booking: facts(['hi']) }).unusable, false)
  assert.equal(brokerReplyProblem(reply, { booking: facts(['MC 741309']) }), null)
  assert.equal(brokerReplyProblem("I need your MC before I book anything.", { booking: facts(['hi']) }), null)
})

// -- Review fixes ---------------------------------------------------------

import { stopsForRow } from '../src/modules/brokerChat/stops.js'

// Kills: natural MC phrasing read as "no MC said"
test('MC phrasing: "our MC is", "MC # is", "M.C.", "<digits> is the mc"', () => {
  for (const t of ['our MC is 741309', 'my mc is 741309', 'MC number is 741309', 'MC # is 741309', 'M.C. 741309', '741309 is the mc', '741309 is our MC']) {
    assert.equal(facts([t]).mc.verdict, 'match', t)
  }
})

// Kills: the widened MC phrasing reading a rate, weight, truck number or DOT as an MC
test('MC phrasing stays safe: rates, weights, truck numbers and DOT are not an MC', () => {
  for (const t of ['rate is 741309 or i walk', 'weight is 123456 lbs', 'truck number is 741309', 'usdot is 741309', 'dot number 741309 and the load is 123456 is the rate']) {
    assert.equal(facts([t]).mc.said, null, t)
  }
})

// Kills: shipper/receiver following the conversation id instead of the posting id
test('stopsForRow: one posting, two conversations, the same stops', () => {
  const row = { postingId: 'posting-1', originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL' }
  assert.deepEqual(stopsForRow({ ...row, id: 'conversation-a' }), stopsForRow({ ...row, id: 'conversation-b' }))
  assert.notDeepEqual(stopsForRow({ ...row, id: 'c', postingId: 'posting-2' }), stopsForRow({ ...row, id: 'c' }))
})

// Kills: an MC said against a blank carrier MC reported as "No MC yet" / "I still need your MC"
test('blank carrier MC: the MC said is unverifiable, not missing', async () => {
  const { callerBlock } = await import('../src/modules/brokerChat/brokerChat.prompt.js')
  const noMc = { name: 'Cedar Ridge Transport Services', mcNumber: '' }
  const f = bookingFacts({ texts: ['MC 741309'], carrier: noMc, posting, now })
  assert.equal(f.mc.verdict, 'unverifiable')
  const block = callerBlock(f, noMc).join('\n')
  assert.match(block, /cannot be checked/)
  assert.doesNotMatch(block, /No MC yet/)
  const gate = carrierNotVerified({ booking: f, contactName: 'Devin' })
  assert.equal(gate.reason, 'mc-unverifiable')
  assert.doesNotMatch(gate.message, /still need your MC/)
  assert.equal(carrierNotVerified({ booking: bookingFacts({ texts: ['hi'], carrier: noMc, posting, now }), contactName: 'Devin' }).reason, 'mc-missing')
})

// -- A booking the broker has no record of --------------------------------------

const EB17 = 'i already booked this with ur guy mike'

// Kills: EB17 -- "Good to hear... locked in with Mike" accepted: the broker
// confirmed a booking and a person that do not exist.
test('confirmsUnknownBooking: confirming a booking nobody made is flagged', () => {
  assert.equal(confirmsUnknownBooking("Good to hear, you're locked in with Mike.", { text: EB17 }), true)
  assert.equal(confirmsUnknownBooking('Yes, Mike has it. You are all set.', { text: EB17 }), true)
  // The claim can be worded other ways.
  assert.equal(confirmsUnknownBooking('Great to hear, confirmed.', { text: 'your colleague gave me this load already' }), true)
  assert.equal(confirmsUnknownBooking('Great to hear, confirmed.', { text: 'we just locked it in yesterday' }), true)
})

// Kills: a denial read as a confirmation (the broker saying it has no record
// is the right answer and must not be regenerated).
test('confirmsUnknownBooking: saying there is no record passes', () => {
  assert.equal(confirmsUnknownBooking("I don't have that on my end, who is Mike?", { text: EB17 }), false)
  assert.equal(confirmsUnknownBooking('No booking here, and no Mike either.', { text: EB17 }), false)
  assert.equal(confirmsUnknownBooking("I can't find any booking on this load.", { text: EB17 }), false)
  assert.equal(confirmsUnknownBooking('Nothing is locked in yet. What is your MC?', { text: EB17 }), false)
})

// Kills: a real booking (agreed or booked in this conversation) being denied,
// which would contradict the rate confirmation on screen.
test('confirmsUnknownBooking: a booking this conversation really has is no claim to deny', () => {
  assert.equal(confirmsUnknownBooking("Good to hear, you're locked in with Mike.", { text: EB17, bookedHere: true }), false)
})

// Kills: the check firing on every "locked in" / "confirmed" with no claim of
// an earlier booking -- ordinary deal talk would be thrown away.
test('confirmsUnknownBooking: no claim of an earlier booking, nothing to check', () => {
  assert.equal(confirmsUnknownBooking("Locked in at $5,475, I'll send the rate con.", { text: 'ok $5,475 works, book it' }), false)
  assert.equal(confirmsUnknownBooking("You're all set.", { text: 'can i book this?' }), false)
  assert.equal(confirmsUnknownBooking("You're all set.", { text: '' }), false)
  assert.equal(confirmsUnknownBooking("You're all set.", {}), false)
})

// Kills: the "says nothing against it" branch dropped: a reply that neither
// confirms nor denies (it just carries on) still goes along with the claim.
test('confirmsUnknownBooking: carrying on without a word against the claim is flagged', () => {
  assert.equal(confirmsUnknownBooking("What's your MC?", { text: EB17 }), true)
})

// Kills: the safe line being a reply the checks themselves flag, and the live
// check not asking confirmsUnknownBooking (or losing the line).
test('brokerReplyProblem: a confirmed phantom booking is unusable and ends on the no-booking line', () => {
  const p = brokerReplyProblem("Good to hear, you're locked in with Mike.", { posting, text: EB17, booking: facts(['hi']) })
  assert.equal(p.why, 'went along with a booking you have no record of')
  assert.equal(p.unusable, true)
  assert.equal(p.safeReply, NO_BOOKING_LINE)
  assert.equal(brokerReplyProblem("Good to hear, you're locked in with Mike.", { posting, text: EB17, bookedHere: true }), null)
  assert.equal(confirmsUnknownBooking(NO_BOOKING_LINE, { text: EB17 }), false)
  assert.equal(brokerReplyProblem(NO_BOOKING_LINE, { posting, text: EB17, booking: facts(['hi']) }), null)
})

// Kills: the confirmation words dropped so only the no-denial fallback is
// left -- a confirmation that has a denial in ANOTHER sentence ("No worries
// on the rate") must still be caught.
test('confirmsUnknownBooking: a confirmation is caught even when another sentence has a denial', () => {
  assert.equal(confirmsUnknownBooking("Good to hear, you're locked in with Mike. No worries on the rate.", { text: EB17 }), true)
  assert.equal(confirmsUnknownBooking("Not sure. Yes, you're all set.", { text: EB17 }), true)
})

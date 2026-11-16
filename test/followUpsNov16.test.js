// Follow-ups to the 2026-11-15 live run: "final"/"firm" only next to a price,
// the live text with non-breaking hyphens, a detail read out is not a price,
// and the paper details asked in their order.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { negotiate, chatIntent, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { varyRepeat, dropStaleRepeatLead, dropRepeatedSentences, REPEAT_LEADS } from '../src/modules/brokerChat/repeatGuard.js'
import { bookingFacts, paperPrerequisite, paperAskOutOfOrder, PAPER_ASK_LINE } from '../src/modules/brokerChat/bookingTalk.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const roomy = negotiate({
  conversation: { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd },
  posting, text: 'Can you do $4,000 all-in?', booking: matched, offerVisible: true,
})
// The rate guard on its own: other guards (weight, trailer) have their own tests.
const problemFor = (reply) => negotiationReplyProblem(reply, roomy)
const quote = `$${roomy.state.offer.toLocaleString('en-US')}`

// ---- 1: "final" / "firm" are price claims only in a price context ----

test('final and firm about something other than the rate are not a rate claim', () => {
  for (const line of [
    `our current quote is ${quote} all-in. send me the final BOL when it is signed.`,
    'the final answer on weight is 42,000 lbs.',
    'we are firm on the MC requirement.',
    `our current quote is ${quote} all-in. the final paperwork comes after the rate con.`,
  ]) assert.equal(problemFor(line), null, line)
  // Kills: bare final/firm flagged with no price word in the clause
})

test('final and firm next to a price are still a rate claim while there is room', () => {
  for (const line of [
    `${quote} all-in is the final price.`,
    `that is final, ${quote} all-in.`,
    `my rate is firm at ${quote} all-in.`,
    `our current quote is ${quote} all-in. that's final.`,
    `${quote} all-in, non-negotiable.`,
  ]) assert.match(problemFor(line) ?? '', /permanent final rate/, line)
  // Kills: dropping the price-context branch (final/firm no longer flagged at all)
  assert.equal(problemFor('the final stop is in Dallas.'), null)
})

// ---- 2: the live text, with U+2011 non-breaking hyphens ----

const NB = '‑'
const PREVIOUS = "i can do $3,750 all-in. i hear the driver's 128-mile deadhead you mentioned."
const LIVE_REPLY = `Like I said, i can do $3,825 all${NB}in. i hear the driver's 128${NB}mile deadhead you mentioned.`

test('live Nov 15 text: new figure, no "Like I said", deadhead sentence not said twice', () => {
  const said = [PREVIOUS]
  let reply = dropRepeatedSentences(dropStaleRepeatLead(LIVE_REPLY, said), said)
  reply = varyRepeat(reply, said)
  assert.ok(!REPEAT_LEADS.some((lead) => reply.startsWith(lead)), reply)
  assert.ok(!/like i said/i.test(reply), reply)
  assert.ok(!/deadhead/i.test(reply), reply)
  assert.match(reply, /3,825/)
  // Kills: dropRepeatedSentences or dropStaleRepeatLead doing nothing on the live text
  // (non-breaking hyphens tokenize like plain ones; this pins that they keep doing so)
})

// ---- 3: details read out are not a price ----

test('an MC, truck number or phone number beside "we have a deal" is not a price', () => {
  for (const openNegotiation of [true, false]) {
    for (const text of [
      'ok we have a deal, my MC is 123456 and truck 4521',
      'we have a deal, call me at 555-123-4567',
      'we have a deal, my phone is (555) 123-4567',
      'we have a deal, my driver is Ana and truck is 4521',
    ]) assert.equal(chatIntent(text, { rateUsd: 3600, rateBasis: 'all_in' }, { openNegotiation }).kind, 'accept', text)
  }
  // Kills: namesFigure without the "is" after a detail keyword, or without the phone shape
})

test('a lead, a figure with "$" and a close phrase stays a price, never an accept', () => {
  for (const text of ['ok $4000 and we have a deal', 'we have a deal, $4000 all-in', 'we have a deal, truck is $4000']) {
    assert.notEqual(chatIntent(text, { rateUsd: 3600, rateBasis: 'all_in' }, { openNegotiation: true }).kind, 'accept', text)
  }
  // Kills: a detail keyword excusing a figure written with "$"
})

// ---- 4: booking order ----

const factsFrom = (...texts) => bookingFacts({ texts, carrier: {}, posting: fakePosting() })

test('"my driver is empty in St George" does not name a driver called Empty', () => {
  const facts = factsFrom('my driver is empty in St George', 'truck 4521')
  assert.equal(facts.driverName, null)
  assert.equal(facts.truckNumber, '4521')
  assert.equal(paperPrerequisite({ ...facts, trailer: { type: 'dry-van', lengthFt: 53 } }), 'driverName')
  // Kills: removing the state words (empty, ready, close, ...) from NAME_STOPS
  assert.equal(factsFrom('driver is ready now').driverName, null)
  assert.equal(factsFrom('driver is close to the pickup').driverName, null)
  assert.equal(factsFrom("driver's name is John Smith").driverName, 'John Smith')
  assert.equal(factsFrom('driver Grace Lindqvist').driverName, 'Grace Lindqvist')
})

test('a reply that asks for the truck number before the driver is out of order', () => {
  const facts = { ...factsFrom('my MC is 123456'), trailer: { type: 'dry-van', lengthFt: 53 } }
  assert.equal(paperPrerequisite(facts), 'driverName')
  assert.equal(paperAskOutOfOrder("What's the truck number?", facts), 'driverName')
  assert.equal(paperAskOutOfOrder("What's the driver's name for the rate con?", facts), null)
  assert.equal(paperAskOutOfOrder("What's the driver's name and the truck number?", facts), null)
  assert.equal(paperAskOutOfOrder('Thanks, I have it.', facts), null)
  // Kills: paperAskOutOfOrder flagging the ask that IS next, or never flagging a later one
})

test('in the booking stage the model reply is held to that order; the server line stands in', () => {
  const agreed = { ...roomy, state: { ...roomy.state, agreed: 4000 }, line: null }
  const booking = { ...factsFrom('my MC is 123456'), mc: { verdict: 'match' }, trailer: { type: 'dry-van', lengthFt: 53, fits: true } }
  const problem = brokerReplyProblem("What's the truck number?", { posting, negotiation: agreed, text: 'ok', booking })
  assert.equal(problem.unusable, true)
  assert.equal(problem.safeReply, PAPER_ASK_LINE.driverName)
  // Kills: the guard missing from brokerReplyProblem, or running before a price is agreed
  const before = brokerReplyProblem("What's the truck number?", { posting, negotiation: roomy, text: 'ok', booking })
  assert.notEqual(before?.why, 'asked for a paper detail out of order')
  assert.equal(brokerReplyProblem(PAPER_ASK_LINE.driverName, { posting, negotiation: agreed, text: 'ok', booking }), null)
})

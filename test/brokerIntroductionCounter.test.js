import { test } from 'node:test'
import assert from 'node:assert/strict'
import { introductionOnly } from '../src/modules/brokerChat/turnTalk.js'
import { chatIntent, negotiate, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { turnTask } from '../src/modules/brokerChat/brokerContext.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'
import { unsupportedRateReasons } from '../src/modules/brokerChat/rateTalk.js'

const greeting = "good moring sir i'm Azizbek from 123 company"
const firstAsk = 'sir can you add more. for exaple 4000$ because at this moment i have only driver and deadhed 230 mile'
const posting = fakePosting({ originCity: 'Memphis', destinationCity: 'Colorado Springs', rateUsd: 3058, distanceMi: 1000 })
const booking = { mc: { verdict: null } }

test('introduction boundary is shared and never hides a real load question', () => {
  for (const text of [greeting, 'wassap brother', 'Good morning sir', "Hi, this is Azizbek from 123 company."]) {
    assert.equal(introductionOnly(text), true, text)
    const negotiation = negotiate({ conversation: {}, posting, text, booking })
    assert.match(turnTask(text, negotiation), /do not name a lane/)
    const problem = brokerReplyProblem('Morning Azizbek, this is Alan. Memphis to Colorado Springs is $3,058 all-in.', { posting, text, booking, negotiation })
    assert.equal(problem?.unusable, true)
    assert.doesNotMatch(problem.safeReply, /Memphis|3,058|load/i)
  }
  for (const text of ['Hi is Memphis to Colorado Springs available?', 'Hey is this load open?', 'Hi can you do $4000?', 'Good morning, rate?']) assert.equal(introductionOnly(text), false, text)
})

test('real example counter and shorthand are money, while stories and dimensions stay inert', () => {
  for (const text of [firstAsk, 'okay lets 4k$', 'can you do $4k?', 'Can you do 4.0k?', 'Need 4k', 'can you do 4000$?']) {
    assert.equal(chatIntent(text).kind, 'offer', text)
    assert.equal(chatIntent(text).rateUsd, 4000, text)
  }
  for (const text of ['He said "can you do 4k".', 'If you can do 4k, I might take it.', 'I cannot accept 4k.',
    'Can you do 4k miles?', 'Need 4k lbs', 'Can you do 4k-5k?', 'For example can you do 4k?',
    'He said can you add more, for example 4000$', greeting]) assert.ok(!['offer', 'accept_amount', 'accept'].includes(chatIntent(text).kind), text)
  for (const text of ['can you do 4k or 5k?', 'can you do $4k or $5000?', 'can you do 4000$ or 5000$?']) assert.equal(chatIntent(text).kind, 'ambiguous', text)
})

test('the exact repeated counter moves within policy without identity or paper', () => {
  const first = negotiate({ conversation: {}, posting, text: firstAsk, booking })
  assert.equal(first.state.pushes, 1)
  const second = negotiate({ conversation: { brokerOfferUsd: first.state.offer, ratePushCount: first.state.pushes }, posting, text: 'okay lets 4k$', booking })
  assert.equal(second.state.pushes, 2)
  assert.ok(second.state.offer > 3058 && second.state.offer <= ceilingFor(posting))
  assert.equal(second.state.agreed, null)
  assert.equal(second.issuePaper, false)
  assert.equal(second.requiresMc, false)
})

test('production send fallback does not pitch a lane on the exact introduction', async () => {
  const fake = makeFakeBrokerRepo({ posting })
  const deps = { repo: fake.repo, getCarrier: async () => null, findById: async () => null,
    assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {},
    chatText: async () => 'Memphis to Colorado Springs is $3,058 all-in.' }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: greeting }, { deps })
  fake.deliverAll()
  assert.doesNotMatch(fake.state.messages.filter((m) => m.role === 'broker').at(-1).content, /Memphis|3,058|load/i)
})

test('hyphenated deadhead dimensions do not become unauthorized money', () => {
  const load = fakePosting({ rateUsd: 8153, distanceMi: 2180 })
  const decision = negotiate({ conversation: { brokerOfferUsd: 8153, ratePushCount: 1 }, posting: load,
    text: 'got 230 mile deadhead brother can u add a little?', booking })
  // Kills: old fixed counter ignoring the current ladder decision.
  assert.ok(decision.state.offer > load.rateUsd && decision.state.offer <= ceilingFor(load))
  assert.equal(negotiationReplyProblem(`I hear the 230‑mile deadhead—happy to bump the rate to $${decision.state.offer.toLocaleString('en-US')} all‑in.`, decision), null)
  for (const reply of ['I hear the 230-mile deadhead; my offer is $9,000 all-in.',
    'I can pay $230-mile for this load.', 'My offer is $9000-mile all-in.']) {
    assert.equal(negotiationReplyProblem(reply, decision), 'offered a rate other than the authoritative decision', reply)
  }
})

test('attributed split confirmation question is not a payment promise', () => {
  const split = fakePosting({ rateUsd: 3058, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: 600 })
  const decision = negotiate({ conversation: {}, posting: split, text: 'okay lets 4k$', booking })
  const raw = 'Just to confirm, is the $4,000 you’re proposing the total rate including fuel, or $4,000 for linehaul with the $600 fuel surcharge added?'
  assert.equal(negotiationReplyProblem(raw, decision), null)
  const retryRaw = 'Just to confirm, are you proposing $4,000 total including fuel, or $4,000 for linehaul with the $600 fuel surcharge added?'
  assert.equal(negotiationReplyProblem(retryRaw, decision), null)
  for (const saved of [
    'Just to clarify, is the $4,000 you’re proposing the total amount including the $600 fuel surcharge, or $4,000 for linehaul with fuel added on top?',
    'Just to confirm, is the $4,000 you mentioned the total amount including fuel, or are you proposing $4,000 for linehaul plus the $600 fuel surcharge?',
    'Just to confirm, does your $4,000 figure represent the total rate including fuel, or are you proposing $4,000 for linehaul plus the $600 fuel surcharge?',
  ]) assert.equal(negotiationReplyProblem(saved, decision), null)
  for (const reply of [raw.replace('$600', '$700'), raw.replace('you’re proposing', 'we can pay'),
    `${raw} I can pay that.`, raw.replace('fuel surcharge added?', 'fuel surcharge added? We have a deal.'),
    'Is our offer $4,000 total or $4,000 linehaul plus $600 fuel?',
    'Are you asking for $4,000 total or $4,000 linehaul plus $700 fuel?',
    'Do you mean $4,000 total or $4,000 linehaul plus $600 fuel; we accept?',
  ]) {
    assert.ok(negotiationReplyProblem(reply, decision), reply)
  }
  assert.equal(decision.state.agreed, null)
  assert.equal(decision.state.pushes, 0)
})

test('the actual valid retry to a 9k total price ask never becomes a weight fallback', () => {
  const load = fakePosting({ rateUsd: 8153, distanceMi: 2180, weightLbs: 38000 })
  const text = 'bro can you do 9k total?'
  const negotiation = negotiate({ conversation: {}, posting: load, text, booking })
  // Kills: reply check rejecting the newly authorized first-step counter.
  const reply = `I can do $${negotiation.state.offer.toLocaleString('en-US')} all‑in for the run. That’s the current offer I have.`
  assert.equal(brokerReplyProblem(reply, { posting: load, text, booking, negotiation }), null)
})

test('carrier hopes may be acknowledged without accepting the requested price', () => {
  const load = fakePosting({ rateUsd: 8153, distanceMi: 2180 })
  const text = 'bro can you do 9k total?'
  const negotiation = negotiate({ conversation: {}, posting: load, text, booking })
  // Kills: wrongly treating an attributed carrier ask as the broker's counter.
  const raw = `I can do $${negotiation.state.offer.toLocaleString('en-US')} all‑in. I get that you were hoping for $9,000, but that’s the rate I have right now.`
  assert.equal(brokerReplyProblem(raw, { posting: load, text, booking, negotiation }), null)
  for (const reply of ['You were hoping for $9,500. I can do $8,153.',
    'You were hoping for $9,000, and I can pay that.',
    'I can offer what you were hoping for $9,000.']) {
    assert.equal(negotiationReplyProblem(reply, negotiation), 'offered a rate other than the authoritative decision', reply)
  }
})

test('an exact attributed deadhead acknowledgment does not verify a route or earn a fee', () => {
  const load = fakePosting({ rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 })
  const options = { posting: load, truck: null, text: 'got 230 mile deadhead brother can u add a little?' }
  assert.deepEqual(unsupportedRateReasons('You mentioned a 230-mile deadhead. I can do $8,353 all-in.', options), [])
  for (const reply of ['You mentioned a 330-mile deadhead. I can do $8,353 all-in.',
    'You mentioned a 230-mile deadhead, so I will bump the rate to $8,353 all-in.',
    'You mentioned a 230-mile deadhead; the actual verified route is long, so I can do $8,353 all-in.',
    'You mentioned a 230-mile deadhead. The actual route is verified, so I can do $8,353 all-in.',
    'You mentioned a 230-mile deadhead with an extra fee of $200. I can do $8,353 all-in.',
    'I see you have a 230-mile deadhead. I can do $8,353 all-in.']) {
    assert.ok(unsupportedRateReasons(reply, options).includes('deadhead'), reply)
  }
})

test('current turn voice distinguishes a quote from an actual concession', () => {
  const first = negotiate({ conversation: {}, posting, text: 'can you do 4k?', booking })
  // Kills: the old no-concession instruction on the first pressure.
  assert.match(turnTask('can you do 4k?', first), /offer increased this turn/)
  const second = negotiate({ conversation: { brokerOfferUsd: first.state.offer, ratePushCount: 1 }, posting, text: 'okay lets 4k$', booking })
  assert.match(turnTask('okay lets 4k$', second), /offer increased this turn/)
  assert.equal(negotiationReplyProblem('The best I can do is $3,058 all-in.', first), 'claimed a permanent final rate while authorized bargaining room remains')
})

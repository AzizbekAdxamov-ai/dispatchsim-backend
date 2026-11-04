// Broker voice and claim guards from the 2026-11-05 live review.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { brokerReplyProblem, echoesCarrierClaim, HELP_DESK_TONE } from '../src/modules/brokerChat/replyProblem.js'
import { agreesRebroker } from '../src/modules/brokerChat/carrierPolicy.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 4000, distanceMi: 1200 })
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }
const decide = (text, extra = {}) => negotiate({
  conversation: { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd },
  posting, text, booking, offerVisible: true, ...extra,
})
const problem = (reply, text, negotiation = null) => brokerReplyProblem(reply, { posting, text, booking, negotiation })

// Kills: live #198 "I'm doing fine, thanks. How can I help you?"
test('"How can I help you?" is help-desk filler', () => {
  const p = problem("I'm doing fine, thanks. How can I help you?", 'hey how are you')
  assert.equal(p.why, 'used help-desk filler')
  assert.equal(p.unusable, true)
  assert.equal(p.safeReply, "I'm doing fine, thanks.")
})

// Kills: live #202 "Sorry for the wait—my best is $4,206 all‑in." (U+2011)
test('an apology for the wait is filler even with a non-breaking hyphen', () => {
  const p = problem('Sorry for the wait—my best is $4,206 all‑in.', 'hello?')
  assert.equal(p.why, 'used help-desk filler')
  assert.ok(p.safeReply.length > 0)
})

// Kills: live #203 "Sorry for the hold‑up…" (U+2011)
test('"Sorry for the hold-up" is filler', () => {
  assert.equal(problem('Sorry for the hold‑up… we are at $4,000 all-in.', 'anyone there?').why, 'used help-desk filler')
})

// Kills: EB26 "...Please let us know as soon as..."
test('"Please let us know" is filler', () => {
  assert.equal(problem('Sure thing. Please let us know as soon as the truck is free.', 'ok').why, 'used help-desk filler')
  assert.doesNotMatch('Let me know when the truck is free.', HELP_DESK_TONE)
})

// Kills: live #209 "Reloads are weak." repeated back as a fact
test('repeating an unsupported carrier reason is caught only when it is unsupported', () => {
  const text = 'theres a lot of deadhead on this one, need $4300'
  const unsupported = decide(text)
  assert.equal(unsupported.unverifiedReason, true)
  const echoed = `I hear you. My offer is $${unsupported.state.offer.toLocaleString('en-US')} all-in.`
  assert.equal(problem(echoed, text, unsupported), null)
  const parroted = 'A lot of deadhead on this one.'
  assert.equal(problem(parroted, text, unsupported).why, "repeated the carrier's unverified claim as fact")
  // Same sentence, but the claim is true of this load: not flagged.
  const supported = decide(text, { truck: { city: 'Joliet', miles: 200, makesIt: true } })
  assert.equal(supported.unverifiedReason, false)
  assert.notEqual(problem(parroted, text, supported)?.why, "repeated the carrier's unverified claim as fact")
  // Two words are not an echo; a question is never one.
  assert.equal(echoesCarrierClaim('Reloads weak.', 'reloads are weak'), false)
  assert.equal(echoesCarrierClaim('Reloads are weak?', 'reloads are weak'), false)
  assert.equal(echoesCarrierClaim('Reloads are weak.', 'reloads are weak'), true)
})

// Kills: live #229 rebroker false positive on a plain MC confirmation
test('confirming the caller\'s own MC is not agreeing to rebroker', () => {
  for (const reply of ['Yep, your MC is good. The Green Bay load is still available.', 'Your MC works, thanks.', 'your MC looks good', 'Yep your MC checks out', 'Sure thing your MC is on file']) {
    assert.equal(agreesRebroker(reply), false, reply)
  }
  for (const reply of ['Use your own MC, that is okay.', 'Put it on my other MC, that works.']) {
    assert.equal(agreesRebroker(reply), true, reply)
  }
})

// Kills: reviewer 2026-11-05 -- "Please let me know your MC." flagged as help-desk filler
test('only "please let us know" is filler; asking the carrier to tell us something is not', () => {
  for (const reply of ['Please let me know your MC.', 'Please let me know when you are loaded.']) {
    assert.doesNotMatch(reply, HELP_DESK_TONE, reply)
    assert.notEqual(problem(reply, 'ok')?.why, 'used help-desk filler', reply)
  }
})

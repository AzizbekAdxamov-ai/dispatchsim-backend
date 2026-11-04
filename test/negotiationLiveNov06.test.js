// Live session 2026-11-06: "I cant cover that rate, can u do 8975" lost its
// amount to the leading "cant", and "I can't do 7300, too light" was heard
// as small talk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent, negotiate } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { cancellationDecision } from '../src/modules/brokerChat/blockPolicy.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const ASK_TEXT = 'I cant cover that rate, can u do 8975?'
const REFUSE_TEXT = "I can't do 7300, too light"
const ASK_USD = 8975
const AGREED_USD = 7300
const POSTED_USD = 7000
const LANE_MI = 2000
const posting = fakePosting({ rateUsd: POSTED_USD, distanceMi: LANE_MI })
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }

test('a refusal ended by a comma does not swallow the ask that follows it', () => {
  // Kills: restoring the whole-clause NEGATIVE check for OFFER matches.
  assert.deepEqual(chatIntent(ASK_TEXT), { kind: 'offer', rateUsd: ASK_USD, emails: [], useOwnEmail: false })
})

test('refusing a price without naming a new one is a push with no amount', () => {
  // Kills: removing REJECT_PRICE, or dropping "too light" from MORE.
  const intent = chatIntent(REFUSE_TEXT)
  assert.equal(intent.kind, 'push')
  assert.equal('rateUsd' in intent, false)
  // Kills: removing REJECT_PRICE alone (no "too light" to fall back on).
  assert.equal(chatIntent("I can't do 7300").kind, 'push')
  // Kills: removing "too light" from MORE alone.
  assert.equal(chatIntent('that is too light').kind, 'push')
  // A figure that is a unit is not a price.
  assert.notEqual(chatIntent("I can't do 7300 miles").kind, 'push')
})

test('a rejected agreed rate is cleared and the ladder gives the next rung', () => {
  const conversation = { status: 'agreed', negotiationStage: 'awaiting_email', brokerOfferUsd: AGREED_USD, agreedRateUsd: AGREED_USD }
  for (const text of [ASK_TEXT, REFUSE_TEXT]) {
    const decision = negotiate({ conversation, posting, text, booking, offerVisible: true })
    assert.equal(decision.state.agreed, null, text)
    assert.ok(decision.state.offer > AGREED_USD, text)
    assert.ok(decision.state.offer <= ceilingFor(posting), text)
    // The cancel policy must not read either as a cancellation.
    assert.equal(cancellationDecision({ status: 'agreed', text }), null, text)
  }
})

test('negations that govern the amount still cancel it', () => {
  // Kills: negatedLocally always returning false (the window no longer reaches the matched phrase).
  for (const text of ["I won't do it for 3000", 'I cannot accept $1800.', 'I cannot do 9000$']) {
    assert.ok(!['offer', 'accept_amount'].includes(chatIntent(text).kind), text)
  }
})

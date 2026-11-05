// 2026-11-05 broker fixes: load questions are not pushes, "work with me" is a
// push, a reasoned first push is never lower than an unreasoned one, an
// unsupported carrier reason is flagged, and a close made before the MC
// checked out is honoured once the MC does.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatIntent, negotiate, bookingTurn, negotiationLines, firstRungOffer } from '../src/modules/brokerChat/negotiation.js'
import { factQuestionLines } from '../src/modules/brokerChat/brokerContext.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 2500, distanceMi: 970, weightLbs: 38000 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const unmatched = { mc: { verdict: null }, trailer: { fits: true } }
const open = (extra = {}) => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd, ...extra })
const turn = (text, conversation = open(), extra = {}) =>
  negotiate({ conversation, posting, text, booking: matched, offerVisible: true, ...extra })

// Kills: live #212 "fcfs or appt?" raised 2,492 -> 2,667; #214, EB27, EB28
test('a question about the load does not move the offer or count as a push', () => {
  for (const text of [
    'fcfs or appt?',
    "total miles including deadhead? whatever you've reported",
    'is this FCFS or strict appointment',
    'what are pickup and delivery appointments',
  ]) {
    assert.equal(chatIntent(text).kind, 'question', text)
    const decision = turn(text)
    assert.equal(decision.state.offer, posting.rateUsd, text)
    assert.equal(decision.state.pushes, 0, text)
    assert.equal(bookingTurn(text, decision), false, text)
  }
  // The reasons still work when they are statements, not questions.
  assert.equal(chatIntent('appointment times are tight, need to price that in').reason, 'tight-window')
})

// Kills: deadhead "whatever you've reported" (EB27) answered without the numbers
test('the deadhead answer carries the loaded miles and the truck distance', () => {
  const intent = chatIntent('total miles including deadhead?')
  const lines = factQuestionLines(intent, { posting, truck: { city: 'Joliet', miles: 469 } }).join(' ')
  assert.match(lines, /469/)
  assert.match(lines, /970/)
  assert.match(lines, /1439/)
  const unknown = factQuestionLines(intent, { posting, truck: null }).join(' ')
  assert.match(unknown, /970/)
  assert.doesNotMatch(unknown, /469/)
  assert.deepEqual(factQuestionLines({ kind: 'push' }, { posting }), [])
  const appt = factQuestionLines(chatIntent('fcfs or appt?'), { posting }).join(' ')
  assert.match(appt, /set appointments, not FCFS/)
})

// Kills: live #200/#203 "can u work on the rate?" / "come on, little more" read as small talk
test('"work with me" and "a little more" are pushes, "a little more time" is not', () => {
  for (const text of ['can u work on the rate?', 'come on, little more', 'work with me on the rate', 'little more?']) {
    assert.equal(chatIntent(text).kind, 'push', text)
  }
  assert.notEqual(chatIntent('can u give me a little more time').kind, 'push')
})

// Kills: live T2 #208 reasoned first push 2,578 below the unreasoned 2,603
test('a reasoned first push never lands below the unreasoned one', () => {
  const heavy = fakePosting({ rateUsd: 1571, distanceMi: 442, weightLbs: 42000 })
  const conv = { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: 1571 }
  const plain = negotiate({ conversation: conv, posting: heavy, text: 'Need $1800.', booking: matched, offerVisible: true })
  const reasoned = negotiate({ conversation: conv, posting: heavy, text: 'Need $1800 for the heavy weight.', booking: matched, offerVisible: true })
  assert.equal(plain.state.offer, firstRungOffer(heavy, 1800))
  assert.ok(reasoned.state.offer > plain.state.offer)
  assert.ok(reasoned.state.offer <= ceilingFor(heavy))
})

// Kills: live #209 "Reloads are weak" repeated back as fact
test('a carrier reason the load does not support is flagged for the reply guard', () => {
  const text = 'theres a lot of deadhead on this one, need $2900'
  // No truck location known: the deadhead claim cannot be backed.
  const unsupported = turn(text)
  assert.equal(unsupported.unverifiedReason, true)
  assert.match(negotiationLines(unsupported).join('\n'), /not supported by this load's facts/)
  // A truck 200 empty miles out (>= the deadhead threshold) makes it true.
  const supported = turn(text, open(), { truck: { city: 'Joliet', miles: 200 } })
  assert.equal(supported.unverifiedReason, false)
  assert.doesNotMatch(negotiationLines(supported).join('\n'), /not supported by this load's facts/)
  // No reason given: nothing to flag.
  assert.equal(turn('Need $2900.').unverifiedReason, false)
  // A tight window claimed for a pickup two days out is unsupported.
  assert.equal(turn('appointment times are tight, need $2900').unverifiedReason, true)
})

// Kills: live T3 #218-#219 "if you can do 3500" before the MC, then the MC, never agreed
test('a close made before the MC checked out is agreed once the MC does', () => {
  const close = turn('if you can do 3500 I will book it', open(), { booking: unmatched })
  assert.equal(close.state.agreed, null)
  assert.equal(close.state.pendingClose, 3500)
  assert.match(negotiationLines(close).join('\n'), /conditional close at \$3,500 is accepted on price/)

  const kept = turn('which dock?', open({ pendingCloseUsd: 3500, brokerOfferUsd: 3500 }), { booking: unmatched })
  assert.equal(kept.state.pendingClose, 3500)
  assert.equal(kept.state.agreed, null)

  const resumed = turn('MC 741309', open({ pendingCloseUsd: 3500, brokerOfferUsd: 3500 }))
  assert.equal(resumed.state.agreed, 3500)
  assert.equal(resumed.state.stage, 'awaiting_email')
  assert.equal(resumed.state.pendingClose, null)

  // A different price replaces it; a fresh push clears it.
  const replaced = turn('Need $3300.', open({ pendingCloseUsd: 3500, brokerOfferUsd: 3500 }))
  assert.notEqual(replaced.state.agreed, 3500)
  assert.equal(replaced.state.pendingClose, null)
})

// Kills: reviewer 2026-11-05 -- bare "work with me" (ETA talk) read as a rate push
test('"work with me" is a push only when it names the rate', () => {
  assert.notEqual(chatIntent('work with me, I will be there in 2 hours').kind, 'push')
  assert.equal(chatIntent('work with me on the rate').kind, 'push')
})

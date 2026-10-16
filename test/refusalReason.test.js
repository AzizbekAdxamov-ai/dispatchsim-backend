// A refusal gives its reason (live:64 ED08/ED13: "No, not doing that.").
// The judgement is src/lib/refusalReason.js, used by the driver chat's
// reply check and by the eval cases.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { asksHerTo, refusesWithoutReason } from '../src/lib/refusalReason.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { DRIVER_CASES } from '../scripts/evalCases.js'

const line = (id) => DRIVER_CASES.find((c) => c.id === id).line

// Kills: asksHerTo reading every dispatcher line as a request (a question
// about detention is not one), or missing the ways dispatchers ask.
test('asksHerTo is true for a request to do something, false for a question', () => {
  assert.equal(asksHerTo('Grace can u deadhead 2500 miles if i pay extra?'), true)
  assert.equal(asksHerTo('Grace skip ur 10 and roll now, broker needs it asap'), true)
  assert.equal(asksHerTo('just log it as off duty and keep driving'), false)
  assert.equal(asksHerTo('Grace any detention at the shipper?'), false)
  assert.equal(asksHerTo(undefined), false)
})

// Kills: "deadhead" in the dispatcher's own line counted as her reason
// (ED13, 2026-10-17: "No, not taking that deadhead." passed).
test('a refusal whose only reason word is the dispatcher\'s own is a refusal without a reason', () => {
  assert.equal(refusesWithoutReason('No, not taking that deadhead.', line('ED13')), true)
  assert.equal(refusesWithoutReason('Not doing it.', line('ED13')), true)
})

// Kills: demanding a reason where nothing was asked of her (ED06 is a
// question; "No detention, no load." is an answer, not a refusal).
test('no refusal is judged when the line asks nothing of her', () => {
  assert.equal(refusesWithoutReason('No detention, no load.', line('ED06')), false)
})

// Kills: a real reason (the 10-hour reset, the empty miles, money) not
// counting, which would regenerate good replies.
test('a refusal with a reason is not flagged', () => {
  assert.equal(refusesWithoutReason("No, my 10 isn't done.", 'Grace skip ur 10 and roll now, broker needs it asap'), false)
  assert.equal(refusesWithoutReason('No, 2,500 miles empty is more than my hours allow.', line('ED13')), false)
  assert.equal(refusesWithoutReason('No, I am still owed $1,200 from the last two.', line('ED13')), false)
  assert.equal(refusesWithoutReason('Copy, rolling to the dock.', line('ED13')), false)
})

// Kills: the shared reply check not reaching the live regeneration, or its
// hint not telling the model what a reason is.
test('the driver reply check regenerates a refusal without a reason', () => {
  const asked = line('ED13')
  const problem = driverReplyProblem('No, not taking that deadhead.', { offer: null, text: asked })
  assert.equal(problem.why, 'turned it down without a reason')
  assert.match(problem.hint, /never a bare no/)
  assert.equal(problem.unusable, false)
  assert.equal(driverReplyProblem('No detention, no load.', { offer: null, text: line('ED06') }), null)
})

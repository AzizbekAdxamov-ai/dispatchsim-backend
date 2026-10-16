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

// Kills: an information request ("send me the BOL", "tell me where you are")
// read as something she could refuse, so a plain "No, haven't got it yet."
// (an answer) was regenerated in the live chat.
test('a no to an information request is an answer, not a refusal', () => {
  const bol = 'Grace can you send me the BOL?'
  for (const reply of ["No, haven't got it yet.", 'No, still waiting on the shipper.', "Not yet, I'm loading.", 'Not sure yet, checking.']) {
    assert.equal(refusesWithoutReason(reply, bol), false, reply)
  }
  assert.equal(refusesWithoutReason("No, I'm in Dallas. Why?", 'Can you tell me where you are?'), false)
  assert.equal(asksHerTo(bol), false)
  assert.equal(asksHerTo('Can you tell me where you are?'), false)
  assert.equal(asksHerTo('Grace can u pick up at 6am?'), true)
})

// Kills: any reply that opens with "No" counted as a turn-down, so
// "No detention, no load." to a pickup request was flagged.
test('only a real turn-down is a refusal; "No, <something else>" is not', () => {
  const pickup = 'Grace can u pick up at 6am?'
  assert.equal(refusesWithoutReason('No detention, no load.', pickup), false)
  assert.equal(refusesWithoutReason('No.', pickup), true)
  assert.equal(refusesWithoutReason('Nope, sorry.', pickup), true)
  assert.equal(refusesWithoutReason("Can't do 6am.", pickup), true)
  assert.equal(refusesWithoutReason('Not today.', pickup), true)
  assert.equal(refusesWithoutReason('6am? no.', pickup), true)
})

// Kills: the rule word lists missing "illegal" / "against the rules" /
// "the law" / "limit", so a good refusal of 14 hours was regenerated.
test('naming the rule as illegal or a limit is a reason', () => {
  const drive = 'Grace drive 14 hrs straight today'
  for (const reply of ["Can't, that's illegal.", "Can't, that's against the rules.", "Can't, it's the law.", "Can't, I'm at my limit."]) {
    assert.equal(refusesWithoutReason(reply, drive), false, reply)
  }
  assert.equal(refusesWithoutReason("Can't do that.", drive), true)
})

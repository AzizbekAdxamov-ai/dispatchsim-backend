// What a broker reply says about the load's weight, checked against the
// posting (src/modules/brokerChat/weightTalk.js). EB18 (2026-10-14): "can u
// add 10k lbs more, my trailer takes 54k" -- the weight is on the load
// sheet and no chat changes it.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { weightChangeAgreed, weightHoldLine, statedWeights } from '../src/modules/brokerChat/weightTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'

const POSTING = {
  id: 'p1', originCity: 'Dallas', destinationCity: 'Chicago', equipmentType: 'dry-van', rateUsd: 2400, distanceMi: 967, weightLbs: 30000,
}
const EB18 = 'can u add 10k lbs more, my trailer takes 54k'
const check = (reply, text = EB18, posting = POSTING) => weightChangeAgreed(reply, { posting, text })

// Kills: statedWeights reading "43.5k" or "43,500 lbs" wrongly (the same
// reader the eval case EB18 uses, moved here).
test('statedWeights reads pounds and k', () => {
  assert.deepEqual(statedWeights('43,500 lbs and 43.5k and 2 pounds'), [43500, 2, 43500])
  assert.deepEqual(statedWeights('no weight here'), [])
})

// Kills: "agrees" read only from a literal "yes" -- EB18's own wording,
// "extra weight isn't an issue", is how the broker said yes.
test('weightChangeAgreed: EB18 "extra weight isn\'t an issue" is flagged', () => {
  assert.equal(check("Extra weight isn't an issue, we can take it."), true)
  assert.equal(check('No problem on the weight.'), true)
})

// Kills: "can add" / "can take" not counted as going along with the ask.
test('weightChangeAgreed: "can add" is flagged', () => {
  assert.equal(check('Yeah I can add that.'), true)
  assert.equal(check('We can take another 10k.'), true)
})

// Kills: a weight the load does not have passing because no change was asked
// for in the line (the broker made 44,000 up on its own).
test('weightChangeAgreed: an invented weight is flagged even with no ask', () => {
  assert.equal(check("It's 44,000 lbs.", 'what is the weight?'), true)
  assert.equal(check('Around 44k.', 'what is the weight?'), true)
})

// Kills: the near-posted tolerance (WEIGHT_NEAR_SHARE) being widened so a
// clearly different weight passes, or dropped so a rounded one is flagged.
test('weightChangeAgreed: within one percent of the posted weight is the posted weight', () => {
  assert.equal(check("It's 30,200 lbs.", 'what is the weight?'), false)
  assert.equal(check("It's 30,000 lbs.", 'what is the weight?'), false)
  assert.equal(check("It's 30,400 lbs.", 'what is the weight?'), true)
  assert.equal(check("It's 29,600 lbs.", 'what is the weight?'), true)
})

// Kills: a weight the dispatcher typed being treated as the broker's own
// when the broker only repeats it to say no.
test('weightChangeAgreed: their own figure repeated back while holding the weight passes', () => {
  assert.equal(check("Your trailer takes 54k, but this one is 30,000 lbs and that doesn't change.", 'my trailer takes 54k'), false)
})

// Kills: the held-weight words ignored, so a broker who says yes-and-no
// ("sure, but it stays 30,000 lbs") is flagged for the "sure".
test('weightChangeAgreed: holding the posted weight passes', () => {
  assert.equal(check("This one is 30,000 lbs as posted, and it doesn't change."), false)
  assert.equal(check("Sure, but I can't add anything, it stays 30,000 lbs."), false)
})

// Kills: "no problem" / "sure" about anything else being read as agreeing to
// a weight change (the line asks nothing about weight).
test('weightChangeAgreed: agreeing to something that is not weight passes', () => {
  assert.equal(check('No problem, 5pm pickup works.', 'can you do a 5pm pickup?'), false)
  assert.equal(check('Sure, send the MC.', 'ready to book'), false)
})

// Kills: a load with no weight on the sheet being judged against nothing.
test('weightChangeAgreed: a posting with no weight has nothing to hold', () => {
  assert.equal(check("It's 44,000 lbs.", 'what is the weight?', { ...POSTING, weightLbs: null }), false)
  assert.equal(check("It's 44,000 lbs.", 'what is the weight?', null), false)
})

// Kills: the hold line being a reply the shared check itself flags (it would
// be thrown away and the holding line shown instead).
test('weightHoldLine passes the weight check and the full broker reply check', () => {
  assert.equal(weightHoldLine(POSTING), "This one is 30,000 lbs as posted, and that doesn't change.")
  assert.equal(check(weightHoldLine(POSTING)), false)
  assert.equal(brokerReplyProblem(weightHoldLine(POSTING), { posting: POSTING, text: EB18, booking: null }), null)
})

// Kills: the live check not asking weightChangeAgreed (or losing the hold
// line): agreeing to more weight must end on the posted weight.
test('brokerReplyProblem: agreeing to more weight is unusable and falls back to the posted weight', () => {
  const p = brokerReplyProblem("Extra weight isn't an issue.", { posting: POSTING, text: EB18 })
  assert.equal(p.why, 'agreed to a weight the load does not have')
  assert.equal(p.unusable, true)
  assert.equal(p.safeReply, weightHoldLine(POSTING))
  assert.match(p.hint, /30,000 lbs/)
})

// -- Routine messages that state a weight or capacity ask for no change -----------

const LOAD = { ...POSTING, weightLbs: 43480 }
const loadCheck = (reply, text) => weightChangeAgreed(reply, { posting: LOAD, text })

// Kills: a bare figure or capacity in the dispatcher's text read as a request
// to change the weight (every "45k capacity" greeting got the safe line).
test('weightChangeAgreed: a capacity or a stated weight is not a change request', () => {
  assert.equal(loadCheck("Sure, $2,000 all-in. What's your MC?", 'hi dry van 45k capacity, whats the rate'), false)
  assert.equal(loadCheck("Yes it's still open. 43,480 lbs.", 'still available? can haul 44,000 lbs'), false)
  assert.equal(loadCheck("Fine, what's your MC?", 'I got a 53ft with 10k lbs of space'), false)
  assert.equal(loadCheck("Sure, what's your MC?", 'can you do $2,300? i have 44k capacity'), false)
})

// Kills: "up to" counted as a change word when it says what the truck takes.
test('weightChangeAgreed: "can take up to 45k lbs" is capacity, not a request', () => {
  assert.equal(loadCheck('Yes, I can send the rate con after MC.', 'truck can take up to 45k lbs'), false)
  assert.equal(loadCheck('Yes, go ahead.', 'can you go up to 50k lbs?'), true)
})

// Kills: the posted-weight exemption removed: a reply that states the posted
// weight is not going along with a different one.
test('weightChangeAgreed: a reply that states the posted weight is not agreeing to another', () => {
  assert.equal(loadCheck('Yes, 43,480 lbs.', 'is it 43,480 lbs?'), false)
  assert.equal(loadCheck('Yes, 43,480 lbs.', 'can u add 10k lbs more'), false)
  assert.equal(loadCheck('Yes, no problem.', 'can u add 10k lbs more'), true)
})

// Kills: a posted-weight reference hiding an explicit offer to add weight.
test('weightChangeAgreed: stating the posted weight cannot mask an offer to add more', () => {
  const ask = 'Can you add 10k lbs more?'
  for (const reply of [
    'Sure, this is 43,480 lbs as posted, and we can add 10k more.',
    'The posted weight is 43,480 lbs. No problem adding 10k lbs.',
    '43,480 lbs as posted, and we can take another 10k lbs.',
    '43,480 lbs as posted, and we can handle 10k lbs more.',
    'The sheet says 43,480 lbs as posted, but 10k more is fine.',
    '43,480 lbs as posted; sure, we can put on 10k more.',
  ]) {
    assert.equal(loadCheck(reply, ask), true, reply)
    assert.equal(brokerReplyProblem(reply, { posting: LOAD, text: ask }).safeReply, weightHoldLine(LOAD))
  }
  assert.equal(loadCheck('This is 43,480 lbs as posted; I cannot add 10k.', ask), false)
  assert.equal(loadCheck('The sheet says 43,480 lbs as posted, but 10k more is not fine.', ask), false)
  assert.equal(loadCheck('43,480 lbs as posted; no, we cannot put on 10k more.', ask), false)
})

// Kills: the request rule dropped for figures (a changed weight put as a
// question, "40k ok?", goes unflagged), or the cue/figure sentence pairing lost.
test('weightChangeAgreed: a different figure put as a request is a change request', () => {
  assert.equal(loadCheck('Sure, no problem.', 'weight? 40k ok?'), true)
  assert.equal(loadCheck('Sure, no problem.', 'can you do 50k lbs?'), true)
})

// Kills: AGREES_WEIGHT matching "sure" inside "not sure" (a hedge read as yes),
// or the denied-agreement strip removed.
test('weightChangeAgreed: a negated "sure" is no agreement', () => {
  assert.equal(loadCheck('Not sure, check the sheet.', 'can u add 10k lbs more'), false)
  assert.equal(loadCheck("That doesn't work for me.", 'can u add 10k lbs more'), false)
})

// Kills: question sentences counted as statements (a yes-word inside a
// question), or their lead-in ("Sure,") ignored so a real yes is missed.
test('weightChangeAgreed: the yes must be said, not asked', () => {
  assert.equal(loadCheck('Is that fine? What is your MC?', 'can u add 10k lbs more'), false)
  assert.equal(loadCheck("Sure, what's your MC?", 'can u add 10k lbs more'), true)
})

// Kills: CHANGE_ASK / REQUEST_CUE missing the casual wordings (no cue for
// "how about", "make it", "actually", "now", bump*, and no "<figure> more").
test('weightChangeAgreed: casual change requests are flagged', () => {
  for (const text of [
    'how about 10k lbs more', 'what about 10k lbs more?', 'how about 48k lbs', 'its actually 48k lbs',
    'make it 48k', 'bumping to 48k', 'load is 48k lbs now', 'i have 10k lbs more to add',
  ]) {
    assert.equal(loadCheck('Sure, no problem.', text), true, text)
  }
})

// Kills: the new cues made too wide -- a capacity or a question about the
// posted weight read as a change request.
test('weightChangeAgreed: capacity and posted-weight talk is still no change request', () => {
  for (const text of [
    'can you do $2,300? i have 44k capacity', 'truck can take up to 45k lbs', 'I got a 53ft with 10k lbs of space',
    'hi dry van 45k capacity, whats the rate', 'still available? can haul 44,000 lbs', 'is it 43,480 lbs?',
  ]) {
    assert.equal(loadCheck('Sure, no problem.', text), false, text)
  }
})

// Kills: leadIn taking "Is that fine" from a question as a yes.
test('weightChangeAgreed: a question with a comma is not a yes', () => {
  assert.equal(loadCheck('Is that fine, or do you need more?', 'can u add 10k lbs'), false)
  assert.equal(loadCheck("Sure, what's your MC?", 'can u add 10k lbs'), true)
})

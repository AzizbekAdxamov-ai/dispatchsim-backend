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

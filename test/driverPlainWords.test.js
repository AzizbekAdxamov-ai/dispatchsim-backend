// Live session 2026-11-06: the driver repeated the system's status notes to
// the dispatcher ("my rest end time isn't verified"). A driver says "not sure
// when my ten's up".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { buildDriverSystemPrompt, offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'

const now = new Date('2026-10-19T13:58:00.000Z')
const RESTING_MIN = 660 // 11 hours of driving left while still in the ten-hour break
const driver = {
  name: 'Grace Lindqvist', cdlClass: 'A', payModel: 'permile', payPerMileCents: 63,
  homeBaseCity: 'Seattle', homeBaseState: 'WA', currentCity: 'Seattle', currentState: 'WA',
  dutyStatus: 'resting', hosRemainingMin: RESTING_MIN,
}
const question = 'When does your current rest end, and what is your earliest HOS-compliant arrival in Central time?'
const texts = ['Hi Grace, can you reach Great Falls, MT for pickup Tuesday at 6:36 AM? Nothing is assigned yet.', question]
const standing = { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 }
const TEN_UP = /ten's up/i
// Words that are the system's, never a driver's (the leak the prompt text caused).
const SYSTEM_WORDS = /verified|feasibility|rest end time/i

// The three replies the model actually sent in the live transcript.
const LIVE_REPLIES = [
  "Portland's about 172 miles from me. My rest end time isn't verified, so I can't give you an arrival time — what time does it need to be there?",
  "11 hours driving left. Rest end time's not verified, so I can't tell you when I can roll.",
  "No ETA — my rest end time isn't verified, so I can't work out when I'd get there.",
]

test('system status wording in a driver reply is unusable and replaced with a driver line', () => {
  const offer = offerFacts({ driver, texts, now })
  for (const reply of LIVE_REPLIES) {
    const problem = driverReplyProblem(reply, { offer, driver, text: 'whats ur eta' })
    // Kills: removing the LEAKED_STATUS_RE check.
    assert.equal(problem?.unusable, true, reply)
    assert.match(problem.safeReply, TEN_UP, reply)
    // The replacement is itself clean.
    assert.equal(driverReplyProblem(problem.safeReply, { offer, driver, text: 'whats ur eta' }), null)
  }
})

test('without a rest to talk about the leak is still unusable but the service picks the holding line', () => {
  // Kills: safeReply claiming a rest the driver is not in.
  const problem = driverReplyProblem('The load feasibility is unverified.', { offer: null, driver: { ...driver, dutyStatus: 'driving' }, text: 'ok?' })
  assert.equal(problem?.unusable, true)
  assert.equal(problem.safeReply, undefined)
})

test('an ordinary use of the word verified is left alone', () => {
  // Kills: widening LEAKED_STATUS_RE to a bare "verified".
  assert.equal(driverReplyProblem('I verified the seal before I left the dock.', { offer: null, driver: { ...driver, dutyStatus: 'driving' }, text: 'did you check the seal?' }), null)
})

test('prompt text does not hand the driver system wording to repeat', () => {
  const resting = buildDriverSystemPrompt({ driver, offer: null, load: null, now, standing })
  const unknownRest = { ...offerFacts({ driver, texts, now }) }
  const withOffer = buildDriverSystemPrompt({ driver, offer: unknownRest, load: null, now, standing })
  const reachable = { city: 'Great Falls', state: 'MT', miles: 608, restEndUnknown: true, makesIt: false,
    earliestAt: new Date('2026-10-21T08:00:00.000Z'), pickupAt: new Date('2026-10-20T11:36:00.000Z') }
  const delivery = { city: 'Great Falls', state: 'MT', miles: 608, deliveryVerified: false, deliveryImpossible: false,
    destinationCity: 'Billings', destinationState: 'MT', loadedMiles: 300, earliestAt: null, makesIt: null, restEndUnknown: false }
  // Kills: reverting any of the four rewritten prompt lines (resting, rest unknown, earliest-if-rolling, delivery).
  for (const text of [resting, withOffer, offerLines(reachable).join('\n'), offerLines(delivery).join('\n'), offerLines(unknownRest).join('\n')]) {
    assert.doesNotMatch(text, SYSTEM_WORDS)
  }
  assert.match(offerLines(reachable).join('\n'), /You don't know when your ten is up/)
  assert.match(offerLines(delivery).join('\n'), /delivery isn't certain/)
})

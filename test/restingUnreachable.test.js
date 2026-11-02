import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { cannotMakeLine } from '../src/lib/cannotMake.js'
import { legalTransitHours, maxLegalDrivingHours, exceedsLegalReach } from '../src/modules/loads/whereabouts.js'

const now = new Date('2026-10-19T17:00:00.000Z')
const grace = {
  name: 'Grace Lindqvist', cdlClass: 'A', payModel: 'permile', payPerMileCents: 63,
  homeBaseCity: 'Seattle', homeBaseState: 'WA', currentCity: 'Seattle', currentState: 'WA',
  dutyStatus: 'resting', hosRemainingMin: 660,
}
const texts = ['Grace got a dallas load next, pu tmrw 8am']
const facts = () => offerFacts({ driver: grace, texts, now })

// Kills: cycle using 14 instead of 11 or omitting the 10h rest; negative/NaN not clamped
test('maxLegalDrivingHours counts 11 driving hours per 21-hour cycle', () => {
  const table = [[0, 0], [-5, 0], [NaN, 0], [5, 5], [11, 11], [15, 11], [21, 11], [25, 15], [42, 22], [50, 30]]
  for (const [hours, want] of table) assert.equal(maxLegalDrivingHours(hours), want, `hours=${hours}`)
})

// Kills: >= instead of >, or slack turning a borderline case into a verdict
test('exceedsLegalReach is strict at the boundary', () => {
  assert.equal(exceedsLegalReach(605, 11), false)
  assert.equal(exceedsLegalReach(606, 11), true)
  assert.equal(exceedsLegalReach(605, 20), false)
  assert.equal(exceedsLegalReach(606, 20), true)
  assert.equal(exceedsLegalReach(606, 21.02), false)
})

// Kills: a bound that rejects a pickup the legal schedule could make
test('whatever the bound rejects, the legal schedule cannot make either', () => {
  for (let m = 0; m <= 3000; m += 50) {
    for (let t = 0; t <= 80; t += 0.5) {
      if (exceedsLegalReach(m, t)) assert.ok(legalTransitHours(m) > t, `miles=${m} hours=${t}`)
    }
  }
})

// Kills: resting branch returning makesIt null before the reach check (the regression)
test('ED07: a resting driver 1,982 miles from an 8am pickup cannot make it', () => {
  const offer = facts()
  assert.equal(offer.miles, 1982)
  assert.equal(offer.makesIt, false)
  assert.equal(offer.restEndUnknown, true)
  assert.equal(offer.earliestAt.getTime(), new Date(now.getTime() + legalTransitHours(1982) * 3600e3).getTime())
  assert.ok(offer.earliestAt.getTime() > offer.pickupAt.getTime())
})

// Kills: ignoresUnreachable/cannotMakeLine not firing for a resting driver
test('a reply that skips the refusal is replaced by the computed line', () => {
  const offer = facts()
  const problem = driverReplyProblem('Copy that, send it over.', { offer, driver: grace, text: texts[0] })
  assert.equal(problem?.unusable, true)
  assert.match(problem.why, /did not say you cannot make that pickup/)
  assert.equal(problem.safeReply, cannotMakeLine(offer))
  assert.match(problem.safeReply, /1,982 mi/)
})

// Kills: inventedRestEta rejecting a computed refusal
test('the computed refusal passes the rest-ETA guard; a yes does not', () => {
  const offer = facts()
  const ask = 'Can you make it?'
  // Not unusable: the rest-ETA guard must not swallow it. (A separate, softer
  // "without a reason" check may still note it; it never replaces the reply.)
  const refusal = driverReplyProblem(cannotMakeLine(offer), { offer, driver: grace, text: ask })
  assert.notEqual(refusal?.unusable, true)
  assert.doesNotMatch(refusal?.why ?? '', /unverified rest end/)
  const yes = driverReplyProblem('Yes, I can make it.', { offer, driver: grace, text: ask })
  assert.equal(yes?.unusable, true)
  assert.equal(yes.safeReply, cannotMakeLine(offer))
})

// Kills: impossible case still telling Grace "Do not calculate"
test('the prompt states the refusal, not the unverified-rest instruction', () => {
  const lines = offerLines(facts()).join('\n')
  assert.match(lines, /cannot make it/)
  assert.match(lines, /even if you could start driving right now/)
  assert.doesNotMatch(lines, /Do not calculate/)
})

// Kills: bound applied with margin / using hosRemainingMin
test('the Great Falls case stays unverified', () => {
  const gfNow = new Date('2026-10-19T13:58:00.000Z')
  const gf = offerFacts({
    driver: grace, now: gfNow,
    texts: ['Hi Grace, can you reach Great Falls, MT for pickup Tuesday at 6:36 AM? Nothing is assigned yet.'],
  })
  assert.equal(gf.miles, 608)
  assert.equal(gf.makesIt, null)
  assert.equal(gf.earliestAt, null)
  assert.match(offerLines(gf).join('\n'), /rest end time is not verified/)
  assert.equal(exceedsLegalReach(600, 20), false)
})

// Kills: new logic leaking into non-resting path
test('an off-duty driver keeps the ordinary path', () => {
  const offer = offerFacts({ driver: { ...grace, dutyStatus: 'off' }, texts, now })
  assert.equal(offer.restEndUnknown, undefined)
  assert.equal(offer.earliestAt.getTime(), new Date(now.getTime() + legalTransitHours(1982, 660) * 3600e3).getTime())
  assert.equal(offer.makesIt, false)
})

// Kills: negative T producing a positive reach
test('a pickup already in the past is not reachable', () => {
  const noon = new Date('2026-10-19T17:00:00.000Z')
  const offer = offerFacts({ driver: grace, texts: ['Grace got a dallas load, pu today 8am'], now: noon })
  assert.equal(offer.makesIt, false)
})

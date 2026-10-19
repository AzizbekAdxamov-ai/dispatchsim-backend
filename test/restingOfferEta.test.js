import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { buildDriverSystemPrompt, offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'

const now = new Date('2026-10-19T13:58:00.000Z')
const driver = {
  name: 'Grace Lindqvist', cdlClass: 'A', payModel: 'permile', payPerMileCents: 63,
  homeBaseCity: 'Seattle', homeBaseState: 'WA', currentCity: 'Seattle', currentState: 'WA',
  dutyStatus: 'resting', hosRemainingMin: 660,
}
const question = 'When does your current rest end, and what is your earliest HOS-compliant arrival in Central time?'
const texts = [
  'Hi Grace, can you reach Great Falls, MT for pickup Tuesday at 6:36 AM? Nothing is assigned yet.',
  question,
]

test('resting with 11 hours and a 608-mile pickup has no verified legal ETA', () => {
  const offer = offerFacts({ driver, texts, now })
  assert.equal(offer.miles, 608)
  assert.equal(offer.restEndUnknown, true)
  assert.equal(offer.earliestAt, null)
  assert.equal(offer.makesIt, null)
  assert.ok(offer.pickupAt instanceof Date)
  const lines = offerLines(offer).join('\n')
  assert.match(lines, /Central time/)
  assert.match(lines, /rest end time is not verified/)
  assert.doesNotMatch(lines, /earliest you could be there|you can make it|you cannot make it/)
  const prompt = buildDriverSystemPrompt({
    driver, offer, load: null, now,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
  })
  assert.match(prompt, /current rest end time is not recorded/)
})

test('the live invented rest end and contradictory arrival are withheld', () => {
  const offer = offerFacts({ driver, texts, now })
  const live = 'My 10-hour rest ends at 12:26 PM PT (3:26 PM Central). Even using the full 11 hours left today, the earliest I could roll into Great Falls is about 12 am Central, well after the 5:36 am pickup.'
  const problem = driverReplyProblem(live, { offer, text: question })
  assert.equal(problem?.unusable, true)
  assert.match(problem.why, /unverified rest end or arrival time/)
  assert.match(problem.safeReply, /608 road miles from Great Falls, MT/)
  assert.doesNotMatch(problem.safeReply, /\b\d{1,2}(?::\d{2})?\s*[ap]m\b/i)
  assert.equal(driverReplyProblem(problem.safeReply, { offer, text: question }), null)
})

test('uncertainty is allowed and routine messages are not blocked', () => {
  const offer = offerFacts({ driver, texts, now })
  const honest = "I don't have a confirmed rest end time, so I can't give you an arrival yet."
  assert.equal(driverReplyProblem(honest, { offer, text: question }), null)
  assert.equal(driverReplyProblem('It is 45 degrees in the box.', { offer, text: 'What is the trailer temperature?' }), null)
  const offDuty = offerFacts({ driver: { ...driver, dutyStatus: 'off' }, texts, now })
  assert.ok(offDuty.earliestAt instanceof Date)
  assert.equal(driverReplyProblem('I can make the pickup at 5:30 AM.', { offer: offDuty, text: question }), null)
})

test('resting driver is protected even if the offer extractor missed the city', () => {
  const invented = 'My rest ends at noon, and I can make it by the pickup.'
  const problem = driverReplyProblem(invented, { offer: null, driver, text: question })
  assert.equal(problem?.unusable, true)
  assert.match(problem.safeReply, /don't have a confirmed end time/)
  assert.equal(driverReplyProblem(problem.safeReply, { offer: null, driver, text: question }), null)
  assert.equal(driverReplyProblem('Truck is in Seattle.', { offer: null, driver, text: 'Where is the truck?' }), null)
})

test('a driver who has left does not negotiate the Great Falls pickup', () => {
  const offer = offerFacts({ driver, texts, now })
  const standing = { stage: 'quits', owedUsd: 529, unpaidCount: 1, daysOverdue: 14 }
  const live = 'My 10-hour rest ends at 12:26 PM PT (3:26 PM Central). Even using the full 11 hours left today, the earliest I could roll into Great Falls is about 12 am Central, well after the 5:36 am pickup.'
  const problem = driverReplyProblem(live, { offer, driver, standing, text: question })
  assert.equal(problem?.unusable, true)
  assert.match(problem.safeReply, /no longer running loads/)
  assert.doesNotMatch(problem.safeReply, /\b\d{1,2}(?::\d{2})?\s*[ap]m\b/i)
  assert.equal(driverReplyProblem(problem.safeReply, { offer, driver, standing, text: question }), null)
  const claim = driverReplyProblem('Yes, I can make it legal and get to Great Falls.', {
    offer, driver, standing, text: 'Can you legally reach Great Falls for the pickup?',
  })
  assert.match(claim.safeReply, /no longer running loads/)
  assert.match(driverReplyProblem("I won't take it, but I could be there by noon.", {
    offer, driver, standing, text: question,
  }).safeReply, /no longer running loads/)
  const refuses = { ...standing, stage: 'refuses' }
  assert.match(driverReplyProblem('I can take it.', { offer, driver, standing: refuses, text: 'Can you take that load?' }).safeReply, /not taking another load/)
  assert.equal(driverReplyProblem("I'm not taking another load until I get paid.", { offer, driver, standing: refuses, text: 'Can you take that load?' }), null)
})

test('the live service checks both initial and regenerated replies against duty and pay stance', () => {
  const source = readFileSync(new URL('../src/modules/driverChat/driverChat.service.js', import.meta.url), 'utf8')
  assert.equal([...source.matchAll(/driverReplyProblem\(reply, \{ offer, text, load: context\.load, driver: context\.driver, standing \}\)/g)].length, 2)
})

test('natural be-there questions cannot draw a guessed ETA or a bare yes', () => {
  const offer = offerFacts({ driver, texts, now })
  const asks = ['Can you be there by 6:36?', 'What time can you be there?', 'When can you get there?']
  const claims = ['Yes, I can be there by 5:30.', 'Yes.', 'I should get there before pickup.']
  for (const text of asks) {
    for (const reply of claims) {
      assert.equal(driverReplyProblem(reply, { offer, driver, text })?.unusable, true, `${text} / ${reply}`)
      assert.equal(driverReplyProblem(reply, { offer, driver, standing: { stage: 'quits' }, text })?.unusable, true, `${text} / ${reply} / quits`)
    }
    assert.equal(driverReplyProblem("I don't know when this rest ends, so I can't give you an arrival yet.", { offer, driver, text }), null)
  }
})

test('work refusal cannot be reversed, while pickup and current-load facts remain answerable', () => {
  const offer = offerFacts({ driver, texts, now })
  const standing = { stage: 'quits' }
  for (const text of ['Can you take the pickup in Great Falls?', 'Are you available for the Great Falls run?']) {
    for (const reply of ["I'm no longer running loads for you, but I can take this one.", "I'm no longer running loads for you, but I should be at Great Falls by dawn.", 'Yes.']) {
      assert.equal(driverReplyProblem(reply, { offer: null, driver, standing, text })?.unusable, true, `${text} / ${reply}`)
    }
  }
  assert.equal(driverReplyProblem("I'm not on a load.", { offer, driver, standing, text: 'What load are you currently on?' }), null)
  assert.equal(driverReplyProblem('Pickup is 6:36 AM Central.', { offer, driver, standing, text: 'What time is the pickup?' }), null)
  assert.equal(driverReplyProblem('Pickup is 6:36 AM Central.', { offer, driver, standing: { stage: 'ok' }, text: 'What time is the pickup?' }), null)
})

test('availability, covering a load and softened promises cannot bypass a quit refusal', () => {
  const standing = { stage: 'quits' }
  for (const text of ['Are you available for this load?', 'Can you cover the Great Falls load?']) {
    const problem = driverReplyProblem('Yes, I can take it.', { offer: null, driver, standing, text })
    assert.equal(problem?.unusable, true, text)
    assert.match(problem.safeReply, /no longer running loads/)
  }
  const problem = driverReplyProblem("I'm no longer running loads for you, but I can legally make it.", {
    offer: null, driver, standing, text: 'Can you reach Great Falls for the pickup?',
  })
  assert.equal(problem?.unusable, true)
})

test('resting driver cannot offer fuzzy arrival times without a verified rest end', () => {
  const offer = offerFacts({ driver, texts, now })
  const text = 'What time can you be there?'
  for (const reply of ["I'm not sure, but I expect tomorrow morning.", 'I should be there by dawn.', 'Probably after lunch.']) {
    assert.equal(driverReplyProblem(reply, { offer, driver, text })?.unusable, true, reply)
  }
  assert.equal(driverReplyProblem("I don't know when this rest ends, so I can't give you an ETA.", { offer, driver, text }), null)
})

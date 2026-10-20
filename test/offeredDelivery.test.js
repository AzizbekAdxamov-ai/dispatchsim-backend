import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'

const now = new Date('2026-10-19T14:00:00Z')
const driver = { currentCity: 'Chicago', currentState: 'IL', dutyStatus: 'off', hosRemainingMin: 660 }
const text = 'Ethan, I have a load of air filters from Rockford, IL to Columbus, OH—about 94 miles deadhead and 442 loaded miles. Pickup is Wednesday, Oct 21 at 6:14 AM Central, with delivery Thursday, Oct 22 at 12:47 AM Central. Both are firm appointments, live load and unload, with no extra equipment required. Can you make both appointments within your available hours?'
const facts = (message = text, who = driver) => offerFacts({ driver: who, texts: [message], now })

test('Ethan live offer keeps pickup and delivery facts separate without asserting delivery legality', () => {
  const offer = facts()
  assert.equal(offer.miles, 94)
  assert.equal(offer.loadedMiles, 442)
  assert.equal(offer.destinationCity, 'Columbus')
  assert.equal(offer.destinationState, 'OH')
  assert.equal(offer.pickupAt.toISOString(), '2026-10-21T11:14:00.000Z')
  assert.equal(offer.deliveryAt.toISOString(), '2026-10-22T05:47:00.000Z')
  assert.equal(offer.makesIt, true)
  assert.equal(offer.deliveryVerified, false)
  assert.equal(offer.deliveryImpossible, false)
  assert.match(offerLines(offer).join('\n'), /Delivery feasibility is not verified/)
  const live = 'Yes, I can hit the 6:14 AM pickup in Rockford and make the 12:47 AM delivery in Columbus.'
  const problem = driverReplyProblem(live, { offer, text, driver })
  assert.equal(problem?.unusable, true)
  assert.match(problem.safeReply, /I can reach the pickup/)
  assert.match(problem.safeReply, /can't confirm delivery/)
  assert.equal(driverReplyProblem(problem.safeReply, { offer, text, driver }), null)
  for (const reply of ['Both appointments work.', 'Yes, I can do that.', "I'll make delivery.", 'I can make both appointments.']) {
    assert.equal(driverReplyProblem(reply, { offer, text })?.unusable, true, reply)
  }
})

test('an obviously impossible loaded leg cannot be promised, even conditionally', () => {
  const message = text.replace('Thursday, Oct 22 at 12:47 AM', 'Wednesday, Oct 21 at 7:14 AM')
  const offer = facts(message)
  assert.equal(offer.deliveryImpossible, true)
  assert.match(offerLines(offer).join('\n'), /cannot make that delivery/)
  for (const reply of ['I can make both appointments.', 'I can make delivery if loading is quick.']) {
    const problem = driverReplyProblem(reply, { offer, text: message, driver })
    assert.match(problem?.safeReply, /loaded driving alone takes longer/)
    assert.equal(driverReplyProblem(problem.safeReply, { offer, text: message, driver }), null)
  }
})

test('unknown loaded mileage, duty and rest do not become verified delivery', () => {
  const message = text.replace(' and 442 loaded miles', '')
  const offer = facts(message, { ...driver, hosRemainingMin: null })
  assert.equal(offer.loadedMiles, null)
  assert.equal(offer.deliveryVerified, false)
  assert.equal(offer.makesIt, null)
  assert.equal(driverReplyProblem('Yes.', { offer, text: message })?.unusable, true)
  assert.equal(driverReplyProblem('I can make delivery if loading and my duty/rest timing allow it.', { offer, text: message }), null)
  assert.equal(driverReplyProblem("I can't confirm delivery until I know loading time and my duty window.", { offer, text: message }), null)
})

test('pickup-only confirmation and factual delivery quotes stay answerable', () => {
  const offer = facts()
  assert.equal(driverReplyProblem('I can make the pickup.', { offer, text: 'Can you make pickup?' }), null)
  assert.equal(driverReplyProblem('Delivery is Thursday at 12:47 AM Central.', { offer, text: 'What time is delivery?' }), null)
  assert.equal(driverReplyProblem('Yes, delivery is at 12:47 AM Central.', { offer, text: 'Is delivery at 12:47 AM?' }), null)
  assert.equal(driverReplyProblem('I can confirm delivery is at 12:47 AM Central.', { offer, text: 'What is the delivery appointment?' }), null)
  assert.equal(driverReplyProblem('Delivery confirmed for Thursday at 12:47 AM Central.', { offer, text: 'What is the delivery appointment?' }), null)
  assert.equal(driverReplyProblem('I cannot make delivery; my rest timing is unknown.', { offer, text }), null)
  const pickupOnly = facts('Got a Rockford, IL load, pickup Wednesday 6:14 AM.')
  assert.equal(pickupOnly.deliveryVerified, undefined)
  assert.equal(driverReplyProblem('I can make that pickup.', { offer: pickupOnly, text: 'Can you make pickup?' }), null)
})

test('a different offer does not inherit the earlier loaded leg', () => {
  const offer = offerFacts({ driver, now, texts: [text, 'What about a Dallas, TX load, pickup Friday 8 AM?'] })
  assert.equal(offer.city, 'Dallas')
  assert.equal(offer.deliveryAt, undefined)
  assert.equal(offer.loadedMiles, undefined)
})

test('review probes cannot promise delivery or use unrelated conditions as an escape', () => {
  const offer = facts()
  for (const reply of [
    'I will deliver on time.', 'Yes, both are doable.', 'I can be there on time.',
    'I can make delivery. Let me know if anything changes.',
    'I can make delivery if the weather is fine.',
    'I will deliver on time. If loading changes, call me.',
  ]) {
    assert.equal(driverReplyProblem(reply, { offer, text })?.unusable, true, reply)
  }
  for (const reply of [
    'I can make delivery if loading and my duty/rest timing allow it.',
    "I can reach pickup, but delivery depends on loading and my duty window.",
    'Delivery is Thursday at 12:47 AM Central.',
  ]) {
    assert.equal(driverReplyProblem(reply, { offer, text }), null, reply)
  }
})

test('same-pickup follow-up keeps delivery facts, while a new same-city load clears them', () => {
  const followup = 'Can you make the Rockford, IL pickup and delivery?'
  const offer = offerFacts({ driver, now, texts: [text, followup] })
  assert.equal(offer.destinationCity, 'Columbus')
  assert.equal(offer.loadedMiles, 442)
  assert.equal(offer.deliveryAt.toISOString(), '2026-10-22T05:47:00.000Z')
  assert.equal(driverReplyProblem('I will deliver on time.', { offer, text: followup })?.unusable, true)
  const next = offerFacts({ driver, now, texts: [text, 'I have another load in Rockford, IL, pickup Friday 8 AM.'] })
  assert.equal(next.deliveryVerified, undefined)
  const changedRoute = offerFacts({ driver, now, texts: [text, 'What about Rockford, IL to Dallas, TX, pickup Friday 8 AM?'] })
  assert.equal(changedRoute.destinationCity, 'Dallas')
  assert.equal(changedRoute.loadedMiles, null)
  assert.equal(changedRoute.deliveryAt, null)
})

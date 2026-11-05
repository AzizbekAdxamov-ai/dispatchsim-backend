// With round posted rates (Azizbek 2026-11-06) the broker's whole ladder must
// stay on $25 multiples: ceiling, first rung, second rung and the max.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'

// Kills: returning an unrounded distance-times-five cap.
test('a lane cap rounds down without dropping below the posted rate', () => {
  const ceiling = ceilingFor({ id: 'rounded-cap', rateUsd: 900, distanceMi: 203 })
  assert.equal(ceiling % 25, 0)
  assert.ok(ceiling >= 900 && ceiling <= 1015)
})
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const STEP = 25
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }
const start = { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: 6300 }
const postingFor = (id) => fakePosting({ id, rateUsd: 6300, distanceMi: 2000 })
const say = (posting, text, conversation = start) => negotiate({ posting, conversation, text, booking, offerVisible: true })

// Walk three plain pushes, carrying the saved state like the service does.
function pushLadder(posting) {
  let conversation = start
  const offers = []
  for (let i = 0; i < 3; i += 1) {
    const decision = say(posting, 'need more', conversation)
    offers.push(decision.state.offer)
    conversation = { ...conversation, brokerOfferUsd: decision.state.offer, ratePushCount: decision.state.pushes }
  }
  return offers
}

// Kills: removing the /25)*25 rounding in ratePolicy.js ceilingFor.
test('the ceiling is a multiple of $25 for any posting id', () => {
  for (const id of IDS) assert.equal(ceilingFor(postingFor(id)) % STEP, 0, id)
})

// Kills: removing round25 in firstRungOffer (negotiation.js) or in the step-2 counter.
test('three pushes climb in $25 multiples and end at the ceiling', () => {
  for (const id of IDS) {
    const posting = postingFor(id)
    const offers = pushLadder(posting)
    const message = `${id}: 6300 -> ${offers.join(' -> ')}`
    assert.ok(offers.every((offer) => offer % STEP === 0), message)
    assert.ok(offers[0] > 6300 && offers[1] > offers[0] && offers[2] > offers[1], message)
    assert.equal(offers[2], ceilingFor(posting), message)
  }
})

// Kills: removing round25 in firstRungOffer (negotiation.js).
test('asking how much room there is answers with a $25 multiple', () => {
  for (const id of IDS) {
    const offer = say(postingFor(id), "what's the best you can do").state.offer
    assert.equal(offer % STEP, 0, `${id}: 6300 -> ${offer}`)
    assert.ok(offer > 6300, `${id}: 6300 -> ${offer}`)
  }
})

// Kills: removing the rounding of the first or second rung (explicit sequence for posting id "a").
test('explicit ladder from a $6,300 posting', () => {
  const offers = pushLadder(postingFor('a'))
  assert.deepEqual(offers, [6550, 6675, 7000], `6300 -> ${offers.join(' -> ')}`)
})

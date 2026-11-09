// Live session 2026-11-10: every broker wrote in the same register. Each broker
// now keeps one writing style (casual / neutral / formal) for good, and the
// reply guards read casual spelling ("u", "ur", "rn") like any other.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BROKER_STYLES, STYLE_INSTRUCTION, brokerStyle, voiceKey, pickVariant } from '../src/modules/brokerChat/brokerStyle.js'
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
import { negotiate, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor, CEILING_STEP_USD } from '../src/modules/brokerChat/ratePolicy.js'
import { mcQuestion, saysBooked } from '../src/modules/brokerChat/bookingTalk.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const BROKER_SAMPLE = 200
const brokerIds = Array.from({ length: BROKER_SAMPLE }, (_, n) => `broker-${n}`)
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }

// Kills: a style that changes between calls (a broker who writes "u" today and "you" tomorrow)
test('a broker keeps one style, and every style is in use', () => {
  for (const id of brokerIds) assert.equal(brokerStyle(id), brokerStyle(id))
  const seen = new Set(brokerIds.map(brokerStyle))
  assert.deepEqual([...seen].sort(), [...BROKER_STYLES].sort())
  for (const style of BROKER_STYLES) assert.ok(STYLE_INSTRUCTION[style].length > 0, style)
})

// Kills: a style instruction that is not in the prompt, or the typo rule being dropped
test('the broker prompt carries the broker\'s own style and still forbids copying the dispatcher', () => {
  for (const style of BROKER_STYLES) {
    const brokerId = brokerIds.find((id) => brokerStyle(id) === style)
    const posting = fakePosting({ brokerId })
    const negotiation = negotiate({ conversation: {}, posting, text: 'hello', booking: matched, offerVisible: true })
    const { systemPrompt } = buildBrokerContext({
      broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
      posting, said: ['hello'], negotiation,
    })
    assert.ok(systemPrompt.includes(STYLE_INSTRUCTION[style]), style)
    for (const other of BROKER_STYLES.filter((s) => s !== style)) assert.ok(!systemPrompt.includes(STYLE_INSTRUCTION[other]), `${style} has ${other}`)
    assert.match(systemPrompt, /Do not copy the dispatcher's typos/)
  }
})

// Kills: voiceKey ignoring the conversation or the revision (the same wording every turn)
test('the decision carries the style and a per-turn voice key', () => {
  const posting = fakePosting({ brokerId: 'broker-7' })
  const turn = (revision) => negotiate({ conversation: { id: 'conv-1', negotiationRevision: revision }, posting, text: 'hello', booking: matched, offerVisible: true })
  const first = turn(1)
  assert.equal(first.style, brokerStyle('broker-7'))
  assert.equal(first.voiceKey, voiceKey({ brokerId: 'broker-7', conversationId: 'conv-1', revision: 1 }))
  assert.notEqual(first.voiceKey, turn(2).voiceKey)
  assert.notEqual(voiceKey({ brokerId: 'a', conversationId: 'c', revision: 1 }), voiceKey({ brokerId: 'b', conversationId: 'c', revision: 1 }))
})

// Kills: pickVariant that is random or leaves the list
test('pickVariant is stable and stays inside the list', () => {
  const list = ['a', 'b', 'c', 'd']
  for (let n = 0; n < BROKER_SAMPLE; n += 1) assert.ok(list.includes(pickVariant(list, `k${n}`)))
  assert.equal(pickVariant(list, 'same'), pickVariant(list, 'same'))
  assert.ok(new Set(brokerIds.map((id) => pickVariant(list, id))).size > 1)
})

// Kills: the guards needing formal spelling (casual "u"/"ur" reads)
test('casual spelling is read by the booking and rate guards', () => {
  assert.equal(mcQuestion('whats ur mc'), true)
  assert.equal(saysBooked('ur booked'), true)
  const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
  const ask = ceilingFor(posting) - CEILING_STEP_USD
  const decision = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd }, posting, text: `can you do ${ask}?`, booking: matched, offerVisible: true })
  const offer = `$${decision.state.offer.toLocaleString('en-US')}`
  const asked = `$${ask.toLocaleString('en-US')}`
  assert.equal(negotiationReplyProblem(`u asked ${asked}, i can do ${offer} rn`, decision), null)
  assert.equal(negotiationReplyProblem(`ur ask of ${asked} is too much, ${offer} is what i got`, decision), null)
})

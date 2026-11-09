// Live session 2026-11-10: every broker wrote in the same register. Each broker
// now keeps one writing style (casual / neutral / formal) for good, and the
// reply guards read casual spelling ("u", "ur", "rn") like any other.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BROKER_STYLES, STYLE_INSTRUCTION, brokerStyle, voiceKey, pickVariant } from '../src/modules/brokerChat/brokerStyle.js'
import { LINE_VARIANTS, VARIANT_MIN, VARIANT_MAX } from '../src/modules/brokerChat/brokerLines.js'
import { quoteText } from '../src/modules/brokerChat/rateQuote.js'
import { trippedBannedWord } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { CHAT_REPLY_MAX_CHARS } from '../src/constants/chatBudget.js'
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

// Band 5 --------------------------------------------------------------------
const VARIANT_KINDS = ['counter', 'meet', 'maxFirst', 'maxAgain', 'walkCounter', 'confirmOffer', 'invalidFigure']
const ROOM_KINDS = ['counter', 'meet', 'walkCounter', 'confirmOffer']
const TURN_SAMPLE = 10
const split = fakePosting({ rateUsd: 5306, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: 1406, distanceMi: 1500 })
const allIn = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const countOf = (text, part) => text.split(part).length - 1

// Kills: a style with too few (stale sameness) or too many variants, or a variant that drops/doubles the quote, asks twice, runs long or says a banned word
test('every fixed rate line has 4 to 6 variants per style, each with the quote once', () => {
  for (const posting of [allIn, split]) {
    const q = quoteText(posting, posting.rateUsd)
    for (const kind of VARIANT_KINDS) {
      for (const style of BROKER_STYLES) {
        const list = LINE_VARIANTS[kind][style]
        assert.ok(list.length >= VARIANT_MIN && list.length <= VARIANT_MAX, `${kind}/${style}`)
        for (const variant of list) {
          const text = variant(q)
          assert.equal(countOf(text, q), 1, text)
          assert.ok(countOf(text, '?') <= 1, text)
          assert.ok(text.length <= CHAT_REPLY_MAX_CHARS, text)
          assert.equal(trippedBannedWord(text), null, text)
        }
      }
    }
  }
})

// Kills: a bargaining-room variant that claims a limit or an agreement (the reply guard would refuse the server's own line)
test('variants used while there is room pass the reply guard', () => {
  for (const posting of [allIn, split]) {
    const decision = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd }, posting, text: 'need more money', booking: matched, offerVisible: true })
    assert.equal(decision.hasRateRoom, true)
    const q = quoteText(posting, decision.state.offer)
    for (const kind of ROOM_KINDS) {
      for (const style of BROKER_STYLES) {
        for (const variant of LINE_VARIANTS[kind][style]) assert.equal(negotiationReplyProblem(variant(q), decision), null, variant(q))
      }
    }
  }
})

// Kills: a random pick (a retried turn must say the same thing) or a fixed pick (every turn the same sentence)
test('the line is stable for one turn and varies across turns', () => {
  const posting = fakePosting({ brokerId: 'broker-3', rateUsd: 3500, distanceMi: 1500 })
  const lineAt = (revision) => negotiate({ conversation: { id: 'conv-9', negotiationRevision: revision, status: 'open', negotiationStage: 'negotiating' }, posting, text: 'what is your best', booking: matched, offerVisible: true }).line
  const lines = Array.from({ length: TURN_SAMPLE }, (_, revision) => lineAt(revision))
  for (let revision = 0; revision < TURN_SAMPLE; revision += 1) assert.equal(lineAt(revision), lines[revision])
  assert.ok(new Set(lines).size >= 2, lines.join(' | '))
})

// Kills: a variant losing the split breakdown (linehaul, fuel and total must all stay in the line)
test('a split quote keeps its linehaul, fuel and total in every line kind', () => {
  const decision = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating' }, posting: split, text: 'what is your best', booking: matched, offerVisible: true })
  assert.ok(decision.line.includes(quoteText(split, decision.state.offer)), decision.line)
  const walk = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating' }, posting: split, text: "I'll pass", booking: matched, offerVisible: true })
  assert.ok(walk.line.includes(quoteText(split, walk.state.offer)), walk.line)
  const absurd = negotiate({ conversation: { status: 'open', negotiationStage: 'negotiating' }, posting: split, text: 'can you do 1000 total?', booking: matched, offerVisible: true })
  assert.ok(absurd.line.includes(quoteText(split, absurd.state.offer)), absurd.line)
  assert.match(absurd.line, /figure/)
})

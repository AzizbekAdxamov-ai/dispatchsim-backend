// Live session 2026-11-06 (turn 253): a split quote was answered with
// "3,700 linehaul + 1,406 fuel = 5,106." -- a wrong sum, sent twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

// Posted split quote: 3,900 linehaul + 1,406 fuel = 5,306 total; the model's 5,106 sum is the live misquote.
const POSTED_TOTAL = 5306
const FUEL = 1406
const split = fakePosting({ rateUsd: POSTED_TOTAL, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: FUEL, distanceMi: 900 })
const MISQUOTE = '3,700 linehaul + 1,406 fuel = 5,106.'
const ASK = 'can you do better?'
const mcBooking = { mc: { verdict: 'match' }, trailer: { fits: true } }

test('a regenerated reply that still misquotes is replaced by the server line', async () => {
  // Kills: removing the unusable/second-layer replacement -- the model's
  // misquote would be saved as the broker's message.
  const decision = negotiate({ conversation: {}, posting: split, text: ASK, booking: mcBooking, offerVisible: true })
  assert.ok(decision.line, 'the turn must carry a server line')
  const fake = makeFakeBrokerRepo({ posting: split, lines: ['Example Freight MC-741309.'] })
  let calls = 0
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => { calls += 1; return MISQUOTE } }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: ASK }, { deps })
  fake.deliverAll()
  const saved = fake.state.messages.filter((m) => m.role === 'broker').at(-1).content
  assert.equal(calls, 2)
  assert.equal(saved, decision.line)
  assert.doesNotMatch(saved, /5,106\./)
})

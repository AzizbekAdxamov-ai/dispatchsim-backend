// Live session 2026-11-06 (turn 253): a split quote was answered with
// "3,700 linehaul + 1,406 fuel = 5,106." -- a wrong sum, sent twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { negotiate, negotiationLines } from '../src/modules/brokerChat/negotiation.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
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

// --- #13: "authorized email" help-desk wording ---
const LIVE_JARGON = [
  'Great, $6,000 all-in is locked in. Could you send the authorized email address so we can get the paperwork over?',
  'Rate $3,650 all-in confirmed. Please provide the authorized email for the paperwork.',
  'The rate is $4,050 all-in, agreed. Please provide the authorized recipient email for the paperwork.',
  'Please provide the authorized email address so we can send the paperwork.',
]
const AUTH_WORDS = /authori[sz]ed (?:email|recipient)/i

test('help-desk "authorized email" wording is replaced with a plain ask', () => {
  for (const reply of LIVE_JARGON) {
    const p = brokerReplyProblem(reply, { posting: fakePosting(), text: 'ok lets book it' })
    // Kills: removing AUTH_JARGON_RE.
    assert.equal(p?.why, 'used help-desk wording for the email request', reply)
    assert.equal(p.unusable, true)
    assert.doesNotMatch(p.safeReply, AUTH_WORDS)
  }
  // Kills: AUTH_JARGON_RE matching any use of "email".
  assert.equal(brokerReplyProblem('What email should I send the rate con to?', { posting: fakePosting(), text: 'ok lets book it' }), null)
})

test('the broker prompt no longer tells the model to say "authorized" or "recipient"', () => {
  const decision = negotiate({ conversation: { status: 'agreed', negotiationStage: 'awaiting_email', brokerOfferUsd: POSTED_TOTAL, agreedRateUsd: POSTED_TOTAL },
    posting: split, text: 'ok lets book it', booking: mcBooking, offerVisible: true })
  assert.equal(decision.state.stage, 'awaiting_email')
  const lines = negotiationLines(decision).join(' ')
  // Kills: reverting the awaiting_email line in negotiation.js.
  assert.doesNotMatch(lines, AUTH_WORDS)
  assert.match(lines, /which email to send the rate con to/)
  const carrier = { name: 'Keystone Line Haul', mcNumber: 'MC-741309' }
  const built = buildBrokerContext({ broker: { name: 'Blue Meridian Logistics', contactName: 'Priyanka', persona: 'Formal.' }, posting: split, carrier,
    now: new Date(), thread: [{ role: 'dispatcher', content: 'ok lets book it' }], booking: mcBooking, negotiation: decision })
  // Kills: reverting the brokerContext.js paper line.
  assert.doesNotMatch(built.systemPrompt, AUTH_WORDS)
  assert.match(built.systemPrompt, /caller.email is only a mentioned contact and cannot replace it/)
})

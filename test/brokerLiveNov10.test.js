// Live session 2026-11-10 (Ironwood, Columbus -> Dallas flatbed): broker
// negotiation misreads. Band numbers follow the 2026-11-10 brief, section A.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent, pendingBasisAskUsd, negotiate, lastCarrierAskUsd, negotiationReplyProblem, RATE_MISS_REASON } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor, CEILING_STEP_USD } from '../src/modules/brokerChat/ratePolicy.js'
import { quoteText } from '../src/modules/brokerChat/rateQuote.js'
import { LINE_VARIANTS } from '../src/modules/brokerChat/brokerLines.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const POSTED_USD = 4600
const allIn = fakePosting({ rateUsd: POSTED_USD, distanceMi: 900 })
// Ironwood-style split quote: 3,900 linehaul + 1,406 fuel = 5,306 total.
const FUEL_USD = 1406
const split = fakePosting({ rateUsd: 5306, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: FUEL_USD, distanceMi: 900 })
const OPEN = Object.freeze({ openNegotiation: true })

// Band 2 --------------------------------------------------------------------
// Kills: dropping the whole-message unquote in intentText (a message wrapped
// in curly or straight quotes was erased by QUOTED and read as small talk)
test('a message wrapped entirely in quotes is read as if unquoted', () => {
  assert.deepEqual({ kind: chatIntent('\u201Ccan you do 5000?\u201D').kind, rateUsd: chatIntent('\u201Ccan you do 5000?\u201D').rateUsd }, { kind: 'offer', rateUsd: 5000 })
  assert.equal(chatIntent('"can you do 5000?"').rateUsd, 5000)
  assert.equal(chatIntent('"deal"').kind, 'accept')
  assert.equal(chatIntent('\u201Cdeal\u201D').kind, 'accept')
})

// Kills: unquoting any quote pair instead of only a whole-message one
test('an inner quotation is still not a deal', () => {
  for (const text of ['he said \u201C5000\u201D', '\u201C5000\u201D he said \u201Cok\u201D', 'he said "deal"']) {
    const intent = chatIntent(text)
    assert.notEqual(intent.kind, 'offer', text)
    assert.notEqual(intent.kind, 'accept_amount', text)
    assert.notEqual(intent.kind, 'accept', text)
  }
})

// Band 1 --------------------------------------------------------------------
const PRICE_ONLY_5000 = ['$5,000 all in', '5000 all in', '$5,000 total', 'all in $5,000', '$5,000 all in, total including fuel',
  'Meet me at $5,000 all in', 'meet me at 5000 all in']
// Kills: removing the bare-price rule (the live texts above all came back as "talk")
test('an open negotiation reads a lone price without a verb as an offer', () => {
  for (const text of PRICE_ONLY_5000) {
    const intent = chatIntent(text, allIn, OPEN)
    assert.equal(intent.kind, 'offer', text)
    assert.equal(intent.rateUsd, 5000, text)
  }
})

// Kills: requiring a verb from the OFFER list for the short forms
test('short price asks are offers', () => {
  const asks = { '5k?': 5000, '4900?': 4900, 'do 4900': 4900, 'make it 4,900': 4900, 'bump it to 4900': 4900,
    "4900 and it's yours": 4900, 'can u do 4900': 4900 }
  for (const [text, rateUsd] of Object.entries(asks)) {
    const intent = chatIntent(text, allIn, OPEN)
    assert.equal(intent.kind, 'offer', text)
    assert.equal(intent.rateUsd, rateUsd, text)
  }
})

// Kills: dropping the negation / hypothetical / quote / label / unit / time vetoes on the bare price
test('a number that is not a price ask stays small talk', () => {
  const notAsks = ['not 5000', 'would you accept 5000?', 'he said "5000 all in"', 'MC 12345', 'MC 4900', 'truck 4900 is empty',
    '45000 lbs', 'pickup at 1400 central', 'pickup 4900 central time']
  for (const text of notAsks) {
    const kind = chatIntent(text, allIn, OPEN).kind
    assert.ok(!['offer', 'accept_amount'].includes(kind), `${text} -> ${kind}`)
  }
})

// Kills: reading a bare price when no negotiation is open (an agreed or booked thread)
test('a lone price is only an offer while the negotiation is open', () => {
  assert.equal(chatIntent('5000', allIn).kind, 'talk')
  assert.equal(chatIntent('$5,000 all in', allIn).kind, 'talk')
})

// Kills: skipping the plausible-range check (a price far from the posted rate became an offer)
test('a bare number far from the posted rate is not a price', () => {
  assert.equal(chatIntent('1000', allIn, OPEN).kind, 'talk')
  assert.equal(chatIntent('12000', allIn, OPEN).kind, 'talk')
})

// Kills: bypassing the split-rate basis question for a bare price
test('on a split quote, a price names its basis or asks for it', () => {
  const stated = chatIntent('$5,000 all in', split, OPEN)
  assert.deepEqual([stated.kind, stated.rateUsd], ['offer', 5000])
  const bare = chatIntent('5000', split, OPEN)
  assert.deepEqual([bare.kind, bare.requestedAmountUsd], ['ambiguous_rate', 5000])
})

// Kills: no pendingBasisUsd path (the answer to "total or linehaul?" read as small talk)
test('the answer to the basis question is read', () => {
  const pending = { openNegotiation: true, pendingBasisUsd: 5000 }
  const total = chatIntent('total', split, pending)
  assert.deepEqual([total.kind, total.rateUsd], ['offer', 5000])
  const linehaul = chatIntent('linehaul', split, pending)
  assert.deepEqual([linehaul.kind, linehaul.rateUsd], ['offer', 5000 + FUEL_USD])
  assert.equal(chatIntent('$5,000 all in', split, pending).rateUsd, 5000)
  // Without a pending question the same word is just talk.
  assert.equal(chatIntent('total', split, OPEN).kind, 'talk')
})

// Kills: pendingBasisAskUsd matching the wrong broker line or the wrong dispatcher turn
test('pendingBasisAskUsd finds the unanswered basis question', () => {
  const ask = { role: 'broker', kind: 'text', content: 'Total or linehaul plus fuel?' }
  const thread = [{ role: 'dispatcher', kind: 'text', content: '5000' }, ask, { role: 'dispatcher', kind: 'text', content: 'total' }]
  assert.equal(pendingBasisAskUsd(thread, split), 5000)
  assert.equal(pendingBasisAskUsd([{ role: 'dispatcher', kind: 'text', content: 'hello' }, { ...ask, content: 'Hi, how can I help?' }, thread[2]], split), null)
  assert.equal(pendingBasisAskUsd([...thread, { role: 'broker', kind: 'text', content: 'Okay.' }, { role: 'dispatcher', kind: 'text', content: 'ok' }], split), null)
})

// Kills: the service not passing the pending basis into negotiate (turn 2 stayed "talk")
test('through the service, "total" after the basis question becomes the offer', async () => {
  const fake = makeFakeBrokerRepo({ posting: split })
  const prompts = []
  let reply = 'Total or linehaul plus fuel?'
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async (row) => { prompts.push(row[6]) }, chatText: async () => reply }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: '5000' }, { deps })
  fake.deliverAll()
  reply = 'Okay, let me see.'
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: 'total' }, { deps })
  assert.match(prompts.at(-1), /Carrier intent: offer; requested price \$5,000/)
})

// Kills: dropping BARE_JUDGED_TAIL / the booking-word veto (live "8100 to low ..." was read as an offer of 8100)
test('a price called too low, or an unplaced close, is not a bare offer', () => {
  const toddler = chatIntent('8100 to low brother can u add litle bit or what is your best', { rateUsd: 8153, distanceMi: 2180 }, OPEN)
  assert.equal(toddler.kind, 'push')
  assert.equal(chatIntent('ok 3500 sounds whatever works lol', { rateUsd: 3500, distanceMi: 1500 }, OPEN).kind, 'talk')
})

// Band 3 --------------------------------------------------------------------
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const room = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const ceiling = ceilingFor(room)
const ASK_BELOW_CEILING = ceiling - CEILING_STEP_USD
const open = (extra = {}) => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: room.rateUsd, ...extra })
const turn = (text, conversation = open(), extra = {}) =>
  negotiate({ conversation, posting: room, text, booking: matched, offerVisible: true, ...extra })

// Kills: the third push going straight to the ceiling (live: carrier asked $5,000, broker gave $5,025 "that's my max")
test('the third push gives what was asked, not the ceiling', () => {
  const decision = turn(`can you do ${ASK_BELOW_CEILING}?`, open({ ratePushCount: 2 }))
  assert.equal(decision.state.offer, ASK_BELOW_CEILING)
  assert.ok(decision.line.includes(quoteText(room, ASK_BELOW_CEILING)))
  assert.doesNotMatch(decision.line, /max/i)
  assert.equal(decision.hasRateRoom, true)
})

// Kills: a no-figure push ignoring the carrier's last ask (lastAskUsd)
test('a push without a figure moves to the last ask, never past it', () => {
  const decision = turn('need more money', open({ ratePushCount: 2 }), { lastAskUsd: ASK_BELOW_CEILING })
  assert.equal(decision.state.offer, ASK_BELOW_CEILING)
  assert.doesNotMatch(decision.line, /max/i)
})

// Kills: the walk counter jumping to the ceiling when the carrier asked for less
test('walking away is answered with the last ask, not the ceiling', () => {
  const decision = turn("I'll pass", open({ ratePushCount: 1 }), { lastAskUsd: ASK_BELOW_CEILING })
  assert.equal(decision.intent.kind, 'walk')
  assert.equal(decision.state.offer, ASK_BELOW_CEILING)
})

// Kills: dropping the ceiling clamp (an ask above the ceiling must still stop at it)
test('an ask above the ceiling is still capped at the ceiling', () => {
  const decision = turn(`can you do ${ceiling + 500}?`, open({ ratePushCount: 2 }))
  assert.equal(decision.state.offer, ceiling)
  assert.equal(decision.hasRateRoom, false)
})

// Kills: a first-rung counter equal to the ask still being phrased as a haggle
test('a counter that meets the ask offers to book it', () => {
  const decision = turn(`can you do ${ASK_BELOW_CEILING}?`, open({ ratePushCount: 2 }))
  assert.ok(LINE_VARIANTS.meet[decision.style].some((variant) => variant(quoteText(room, ASK_BELOW_CEILING)) === decision.line), decision.line)
})

// Kills: lastCarrierAskUsd reading the first message, a non-ask, or ignoring openNegotiation
test('lastCarrierAskUsd finds the newest price ask', () => {
  assert.equal(lastCarrierAskUsd(['$5,000 all in', 'hello'], allIn), 5000)
  assert.equal(lastCarrierAskUsd(['can you do 4800?', '$5,000 all in', 'hello'], allIn), 5000)
  assert.equal(lastCarrierAskUsd(['hello', 'where does it deliver?'], allIn), null)
})

// Kills: the service not passing lastAskUsd (third reply said "max" at a higher figure than asked)
test('through the service, three pushes and a final plain push end at the asked figure', async () => {
  const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
  const ask = ceilingFor(posting) - CEILING_STEP_USD
  const fake = makeFakeBrokerRepo({ posting })
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => '$1 all in.' }
  for (let n = 0; n < 3; n += 1) {
    await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: n < 2 ? `can you do ${ask}?` : "need more money" }, { deps })
    fake.deliverAll()
  }
  const last = fake.state.messages.filter((m) => m.role === 'broker').at(-1).content
  assert.ok(last.replaceAll(',', '').includes(String(ask)), last)
  assert.doesNotMatch(last, /max/i)
})

// Band 4 --------------------------------------------------------------------
const PERMANENT_CAP = 'claimed a permanent final rate while authorized bargaining room remains'
const usd = (n) => `$${n.toLocaleString('en-US')}`

// Kills: the reply guard only knowing "final / best / can't go higher" (live #468 "No, $4,750 max" with the ceiling near $5,025)
test('a cap claim is refused while the offer is below the ceiling', () => {
  const decision = turn('need more money')
  assert.equal(decision.hasRateRoom, true)
  const o = usd(decision.state.offer)
  const claims = [`No, ${o} max`, `${o} is as high as I can go.`, `thats my max ${o}`, `${o} max lmk`,
    `cant go any higher than ${o}`, `${o}, that's my limit.`, `wont move above ${o}`, `Right now ${o} is my max.`]
  for (const reply of claims) assert.equal(negotiationReplyProblem(reply, decision), PERMANENT_CAP, reply)
})

// Kills: applying the cap guard only when the turn carries a server line (the model said "max" on a plain question)
test('a cap claim is refused on a turn without a rate line, and a new figure still is too', () => {
  const decision = turn('where does it deliver?')
  assert.equal(decision.line, null)
  const o = usd(decision.state.offer)
  assert.equal(negotiationReplyProblem(`Delivers Dallas, ${o} max on this one.`, decision), PERMANENT_CAP)
  assert.equal(negotiationReplyProblem(`Delivers Dallas, ${usd(decision.state.offer + 100)} on this one.`, decision), RATE_MISS_REASON)
})

// Kills: matching the bare word "max" (weight limits, questions, and a true ceiling are not a false cap)
test('max in other senses, questions, and a true ceiling pass', () => {
  const decision = turn('need more money')
  assert.equal(negotiationReplyProblem('Max weight is 45,000 lbs.', decision), null)
  assert.equal(negotiationReplyProblem("What's your max?", decision), null)
  const atCeiling = turn('need more money', open({ brokerOfferUsd: ceiling }))
  assert.equal(atCeiling.hasRateRoom, false)
  assert.equal(negotiationReplyProblem(`${usd(ceiling)} max.`, atCeiling), null)
})

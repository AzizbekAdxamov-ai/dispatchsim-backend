import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateQuote, quoteText, paperQuote } from '../src/modules/brokerChat/rateQuote.js'
import { chatIntent, negotiate, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { getAgreedRate } from '../src/modules/brokerChat/brokerChat.repository.js'
import { rateConInput } from '../src/modules/brokerChat/rateConInput.js'
import { buildInvoice } from '../src/modules/finance/finance.service.js'
import { createLoad } from '../src/modules/loads/loads.repository.js'
import { sendMessage, getRateConfirmation } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'
import { buildListPostingsSql } from '../src/modules/loadBoard/loadBoard.repository.js'
import { buildPostingRows, roundPostedRate } from '../scripts/seed/postings.js'
import { generateLoad } from '../scripts/seed/generate.js'
import { validateLoadItem } from '../scripts/seed/validate.js'
import { mulberry32 } from '../scripts/seed/build.js'
import { runPostingRefresh } from '../scripts/refresh-postings.js'
import { formatDate, formatDateTime } from '../src/modules/brokerChat/rateConfirmation.js'

const posting = fakePosting({ rateUsd: 3058, distanceMi: 1000, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: 500 })
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }

test('the quote keeps one canonical total and rejects invalid component contracts', () => {
  assert.equal(rateQuote(posting).linehaulUsd, 2558)
  assert.equal(quoteText(posting), '$2,558 linehaul plus $500 fuel ($3,058 total)')
  assert.deepEqual(rateQuote({ rateUsd: 3058 }), { rateUsd: 3058, rateBasis: 'all-in', fuelSurchargeUsd: 0, linehaulUsd: null })
  for (const source of [{ ...posting, fuelSurchargeUsd: 0 }, { ...posting, fuelSurchargeUsd: 3058 },
    { ...posting, fuelSurchargeUsd: -1 }, { ...posting, rateBasis: 'unknown' }, { ...posting, rateBasis: 'all-in' }]) assert.throws(() => rateQuote(source))
})

test('split counters clarify bare amounts, add fixed fuel to explicit linehaul only once', () => {
  for (const text of ['okay lets 4k$', 'Can you do $4000?', 'I accept 4.0k']) {
    assert.equal(chatIntent(text, posting).kind, 'ambiguous_rate', text)
    const result = negotiate({ posting, conversation: { brokerOfferUsd: 3058, ratePushCount: 1 }, booking, text })
    assert.equal(result.state.offer, 3058)
    assert.equal(result.state.pushes, 1)
    assert.equal(result.state.agreed, null)
    assert.equal(result.changed, false)
    assert.equal(result.issuePaper, false)
    assert.match(result.line, /total including fuel, or linehaul/)
  }
  assert.equal(chatIntent('Can you do $4000 linehaul plus fuel?', posting).rateUsd, 4500)
  assert.equal(chatIntent('Can you do 4k total?', posting).rateUsd, 4000)
  assert.equal(chatIntent('Need 4k all-in', posting).rateUsd, 4000)
  assert.equal(chatIntent('Need 4k linehaul total', posting).kind, 'ambiguous_rate')
  assert.equal(chatIntent('Can you do 3000? He said "linehaul".', posting).kind, 'ambiguous_rate')
  assert.equal(chatIntent('Can you do 3000? He said "total".', posting).kind, 'ambiguous_rate')
  assert.equal(chatIntent('3000 total works for me.', posting).kind, 'accept_amount')
  assert.equal(chatIntent('2558 linehaul works for me.', posting).rateUsd, 3058)
  assert.equal(chatIntent('Need 4k', { rateUsd: 3058 }).rateUsd, 4000)
  assert.equal(chatIntent('If I need 4k linehaul, what happens?', posting).kind, 'talk')
  assert.equal(chatIntent('Can you do 1.2345k total?', posting).kind, 'ambiguous_rate')
  assert.equal(chatIntent('Can you do 1.5k total?', posting).rateUsd, 1500)
  assert.equal(chatIntent('Can you do 1.001k total?', posting).rateUsd, 1001)
  assert.doesNotThrow(() => negotiate({ posting, conversation: {}, booking, text: 'Can you do 1.2345k total?' }))
})

test('paper appointments use the operation zone through midnight and the daylight transition', () => {
  assert.equal(formatDate('2026-10-23T02:30:00Z'), 'Oct 22, 2026')
  assert.equal(formatDateTime('2026-10-23T12:00:00Z'), 'Oct 23, 2026 07:00 AM')
  assert.equal(formatDateTime('2026-11-01T06:30:00Z'), 'Nov 1, 2026 01:30 AM')
  assert.equal(formatDateTime('2026-11-01T08:30:00Z'), 'Nov 1, 2026 02:30 AM')
})

test('a low total that would make linehaul negative is rejected without throwing', () => {
  const costlyFuel = { ...posting, fuelSurchargeUsd: 2000 }
  const result = negotiate({ posting: costlyFuel, conversation: {}, booking, text: 'Can you do 1500 total?' })
  assert.equal(result.state.agreed, null)
  assert.equal(result.state.offer, 3058)
  assert.match(result.line, /figure/)
})

test('reply validation binds every component to its label and cannot approve another total', () => {
  const decision = negotiate({ posting, conversation: {}, booking, text: 'What is the rate?' })
  for (const reply of [quoteText(posting), 'Linehaul $2,558 plus fuel $500. The total is $3,058.', '$3,058 total including fuel.',
    'Linehaul is $2,558, fuel surcharge is $500, total $3,058.', '$3,058 total, no fuel on top.',
    '$2,558 linehaul plus $500 fuel equals $3,058 total.']) assert.equal(negotiationReplyProblem(reply, decision), null, reply)
  for (const reply of ['My offer is $2,558 all-in.', 'Fuel is $3,058.', '$3,558 total.',
    '$2,558 linehaul plus $700 fuel.', 'I can do 4k.', 'My offer is $4k.', '$3,058 total plus $500 fuel.',
    '$3,058 plus $500 fuel.', '$3,058 all-in plus $500 fuel.', '$3,058 total, plus $500 fuel.',
    '$3,058 total and $500 fuel on top.']) assert.ok(negotiationReplyProblem(reply, decision), reply)
  const ask = negotiate({ posting, conversation: {}, booking, text: 'Can you do $4000 linehaul?' })
  // Kills: validating a stale total after the first authorized rate step.
  const total = ask.state.offer.toLocaleString('en-US')
  const linehaul = (ask.state.offer - posting.fuelSurchargeUsd).toLocaleString('en-US')
  assert.equal(negotiationReplyProblem(`You asked for $4,000 linehaul. My offer is $${linehaul} linehaul plus $500 fuel ($${total} total).`, ask), null)
})

test('the actual live basis clarification may repeat the unresolved ask without authorizing it', () => {
  const split = { ...posting, fuelSurchargeUsd: 600 }
  const decision = negotiate({ posting: split, conversation: {}, booking, text: 'okay lets 4k$' })
  assert.equal(decision.intent.requestedAmountUsd, 4000)
  assert.equal(decision.state.offer, 3058)
  assert.equal(decision.state.agreed, null)
  const raw = 'Do you mean $4,000 total including fuel, or $4,000 for linehaul plus the $600 fuel surcharge?'
  assert.equal(negotiationReplyProblem(raw, decision), null)
  assert.equal(negotiationReplyProblem('Do you mean $4,000 total or $4,000 linehaul ($4,600 total)?', decision), null)
  for (const reply of ['Can I confirm $4,000?', 'Do you mean $4,000 total or $4,000 linehaul, and can I book it?',
    'Do you mean $4,000 total or $4,000 linehaul? I can pay $4,000.',
    'Do you mean $5,000 total or $4,000 linehaul?',
    'Do you mean $4,000 total or $4,000 linehaul plus $800 fuel?',
    'Do you mean $4,000 total or $4,000 linehaul ($4,800 total)?']) assert.ok(negotiationReplyProblem(reply, decision), reply)
})

test('paper freezes the actual paper total and components; posting changes do not rewrite it', async () => {
  const load = { ...posting }
  const fake = makeFakeBrokerRepo({ posting: load, lines: ['This is Keystone Line Haul, MC-741309. 53-foot dry van, driver is Ethan, truck #12.'] })
  const ids = { conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user }
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Keystone Line Haul', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {},
    chatText: async () => 'No valid agreement prose.' }
  await sendMessage({ ...ids, text: 'I accept $3058 total.' }, { deps })
  await sendMessage({ ...ids, text: 'dispatch@example.com' }, { deps })
  fake.deliverAll()
  assert.equal(fake.state.conversation.rateConBasis, 'linehaul-plus-fuel')
  assert.equal(fake.state.conversation.rateConFuelSurchargeUsd, 500)
  load.rateBasis = 'all-in'; load.fuelSurchargeUsd = 0
  const paper = await getRateConfirmation(ids, { deps })
  const input = rateConInput(paper, null)
  assert.equal(input.conversation.linehaulUsd, 2558)
  assert.equal(input.conversation.fuelSurchargeUsd, 500)
  await sendMessage({ ...ids, text: 'hold up dont book yet' }, { deps })
  assert.equal(fake.state.conversation.rateConRateUsd, null)
  assert.equal(fake.state.conversation.rateConBasis, null)
  assert.equal(fake.state.conversation.rateConFuelSurchargeUsd, null)
})

test('old paper remains all-in and reduced paper derives its linehaul from the actual document total', () => {
  assert.equal(paperQuote({ ...posting, rateConRateUsd: 2900, agreedRateUsd: 3058 }).rateBasis, 'all-in')
  const quote = paperQuote({ rateConRateUsd: 2900, agreedRateUsd: 3058, rateConBasis: 'linehaul-plus-fuel', rateConFuelSurchargeUsd: 500 })
  assert.equal(quote.linehaulUsd, 2400)
  assert.equal(quote.rateUsd, 2900)
})

test('booking reads the locked frozen quote; load and invoice never add fuel twice', async () => {
  const client = { query: async (sql, values) => {
    assert.match(sql, /rate_con_basis/)
    assert.match(sql, /FOR UPDATE/)
    assert.deepEqual(values.slice(2), [FAKE_IDS.conversation, 8])
    return { rows: [{ rate: 2900, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: 500 }] }
  } }
  const quote = await getAgreedRate(client, FAKE_IDS.posting, FAKE_IDS.user, { conversationId: FAKE_IDS.conversation, revision: 8 }, { withQuote: true })
  let bound
  await createLoad({ query: async (sql, values) => { bound = values; return { rows: [{ id: '123456' }] } } }, { ...quote, id: '123456' })
  assert.equal(bound[7], 2900)
  assert.equal(bound[19], 'linehaul-plus-fuel')
  assert.equal(bound[20], 500)
  const invoice = buildInvoice({ ...quote, loadId: '123456', bookedAt: '2026-10-23', accessorials: [{ label: 'Detention', amountUsd: 85 }] })
  assert.equal(invoice.amountUsd, 2985)
  assert.deepEqual(invoice.lineItems.map((i) => i.amountUsd), [2400, 500, 85])
  assert.equal(invoice.lineItems.reduce((sum, i) => sum + i.amountUsd, 0), invoice.amountUsd)
})

test('board query redacts every hidden rate component; seeded totals are rounded and both bases exist', () => {
  const sql = buildListPostingsSql({ sort: 'posted', limit: 25, offset: 0 }).text
  for (const column of ['rate_usd', 'rate_basis', 'fuel_surcharge_usd']) assert.ok(sql.includes(`CASE WHEN p.rate_hidden THEN NULL ELSE p.${column} END`))
  assert.match(sql, /CASE WHEN p.rate_hidden OR p.rate_basis = 'all-in' THEN NULL/)
  const rng = mulberry32(23)
  const items = Array.from({ length: 100 }, () => validateLoadItem(generateLoad(rng)).item)
  const build = () => buildPostingRows({ rng: mulberry32(24), postingItems: items, drivers: [], trucks: [], fleetEquipment: [] })
  const rows = build()
  assert.deepEqual(rows, build())
  assert.ok(rows.some((row) => row.rate_basis === 'all-in'))
  assert.ok(rows.some((row) => row.rate_basis === 'linehaul-plus-fuel'))
  for (const row of rows) {
    const input = items.find((item) => item.originCity === row.origin_city && item.destinationCity === row.destination_city && item.broker === row.broker)
    const lowerBound = Math.max(100, input.distanceMi)
    const upperBound = Math.min(20000, input.distanceMi * 5)
    const clamped = Math.min(20000, input.distanceMi * 5, Math.max(100, input.distanceMi, Math.round(input.distanceMi * input.ratePerMile)))
    assert.equal(row.rate_usd, roundPostedRate({ rateUsd: clamped, fuelUsd: row.fuel_surcharge_usd, lowerBound, upperBound }))
    rateQuote({ rateUsd: row.rate_usd, rateBasis: row.rate_basis, fuelSurchargeUsd: row.fuel_surcharge_usd })
  }
})

test('postings-only refresh inserts bounded freight only and rolls back an insert failure', async () => {
  const seen = []
  const client = { query: async (sql) => { seen.push(sql); if (sql.startsWith('INSERT')) throw new Error('fixture insert failure'); return { rows: [] } }, release() {} }
  const runner = { query: async (sql) => ({ rows: [] }), connect: async () => client }
  await assert.rejects(runPostingRefresh({ count: 0, runner }), /1–60/)
  await assert.rejects(runPostingRefresh({ count: 61, runner }), /1–60/)
  await assert.rejects(runPostingRefresh({ count: 2, runner }), /fixture insert failure/)
  assert.equal(seen[0], 'BEGIN')
  assert.match(seen[1], /^INSERT INTO load_postings/)
  assert.equal(seen.at(-1), 'ROLLBACK')
  assert.ok(seen.every((sql) => !/DELETE|TRUNCATE|driver_applicants|truck_listings/.test(sql)))
})

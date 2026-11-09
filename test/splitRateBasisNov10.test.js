// Live session 2026-11-10: the dispatcher answered "total" to the basis
// question, and a few turns later "can you do 5,000?" was asked the same
// question again. The basis answered once now holds for the rest of the thread.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatIntent, lastCarrierAskUsd, negotiate, pendingBasisAskUsd, settledRateBasis } from '../src/modules/brokerChat/negotiation.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const FUEL = 600
const split = fakePosting({ rateUsd: 4200, rateBasis: 'linehaul-plus-fuel', fuelSurchargeUsd: FUEL, distanceMi: 1500 })
const allIn = fakePosting({ rateUsd: 3500, rateBasis: 'all-in', distanceMi: 1500 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const QUESTION = 'Do you mean the total including fuel, or linehaul plus the listed fuel amount?'
const said = (content) => ({ role: 'dispatcher', kind: 'text', content })
const broker = (content) => ({ role: 'broker', kind: 'text', content })
const asked = [said('can you do 4,800?'), broker(QUESTION)]
const settledTotal = [...asked, said('total'), broker('I can do $4,500 all in.')]
const settledLinehaul = [...asked, said('linehaul'), broker('Linehaul 4,800 plus fuel works.')]

// Kills: the basis question repeating for every later figure (the live loop)
test('after "total", a later bare figure is an offer at that figure', () => {
  const basis = settledRateBasis([...settledTotal, said('can you do 5,000?')], split)
  assert.equal(basis, 'total')
  const intent = chatIntent('can you do 5,000?', split, { openNegotiation: true, settledBasis: basis })
  assert.equal(intent.kind, 'offer')
  assert.equal(intent.rateUsd, 5000)
})

// Kills: a "linehaul" answer not adding the listed fuel to later figures
test('after "linehaul", a later bare figure is linehaul plus the listed fuel', () => {
  const basis = settledRateBasis([...settledLinehaul, said('can you do 4,500?')], split)
  assert.equal(basis, 'linehaul')
  const intent = chatIntent('can you do 4,500?', split, { openNegotiation: true, settledBasis: basis })
  assert.equal(intent.kind, 'offer')
  assert.equal(intent.rateUsd, 4500 + FUEL)
})

// Kills: the first answer still working while a later one is lost (the pending ask path stays)
test('the answer itself still resolves through the pending ask', () => {
  const thread = [...asked, said('total')]
  assert.equal(pendingBasisAskUsd(thread, split), 4800)
  assert.equal(settledRateBasis(thread, split), null)
})

// Kills: a figure that names its own basis being ignored
test('"4,800 all in" settles the basis for the next bare figure', () => {
  const thread = [said('4,800 all in'), broker('I can do $4,500.'), said('can you do 5,000?')]
  assert.equal(settledRateBasis(thread, split), 'total')
})

// Kills: the settled basis overriding a basis named in the message itself
test('a message that names the other basis keeps its own', () => {
  const intent = chatIntent('5,000 linehaul plus fuel', split, { openNegotiation: true, settledBasis: 'total' })
  assert.equal(intent.rateUsd, 5000 + FUEL)
})

// Kills: guessing a basis when none was ever given
test('with no basis given anywhere the figure is still ambiguous', () => {
  const thread = [said('hello'), broker('Hi, how can I help?'), said('can you do 5,000?')]
  assert.equal(settledRateBasis(thread, split), null)
  assert.equal(chatIntent('can you do 5,000?', split, { openNegotiation: true, settledBasis: null }).kind, 'ambiguous_rate')
})

// Kills: a settled basis changing the all-in posting
test('an all-in posting has no settled basis and reads figures as before', () => {
  assert.equal(settledRateBasis(settledTotal, allIn), null)
  assert.equal(chatIntent('can you do 4,000?', allIn, { openNegotiation: true }).rateUsd, 4000)
})

// Kills: the earlier ask being invisible to the "never above their ask" cap
test('lastCarrierAskUsd reads the earlier ask on the settled basis', () => {
  assert.equal(lastCarrierAskUsd(['can you do 5,000?'], split, 'total'), 5000)
  assert.equal(lastCarrierAskUsd(['can you do 5,000?'], split, null), null)
})

// Kills: negotiate() dropping settledBasis (the live turn asking the question again)
test('negotiate: a bare figure after a settled total is bargained, not asked about', () => {
  const decision = negotiate({
    conversation: { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: split.rateUsd },
    posting: split, text: 'can you do 5,000?', booking: matched, offerVisible: true, settledBasis: 'total',
  })
  assert.notEqual(decision.intent.kind, 'ambiguous_rate')
  assert.equal(decision.intent.rateUsd, 5000)
})

// Kills: the service computing the basis but not handing it to the turn or the ask cap
test('the reply service hands the settled basis to negotiate and to the ask cap', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/modules/brokerChat/brokerChat.service.js', import.meta.url), 'utf8')
  assert.match(src, /settledBasis = settledRateBasis\(thread, posting\)/)
  assert.match(src, /^\s+settledBasis,$/m)
  assert.match(src, /lastCarrierAskUsd\(.*, posting, settledBasis\)/)
})

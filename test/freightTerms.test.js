// The trade's own words (src/constants/freightTerms.js): which ones a
// dispatcher used, what they pinned down before booking, and what the
// broker is told about it.
//
// Every test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FREIGHT_TERMS, termsUsed, talkFacts, confirmationsFor } from '../src/constants/freightTerms.js'
import { talkBlock, buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { dispatcherTexts, brokerTexts } from '../src/modules/brokerChat/brokerChat.service.js'

// One real sentence per term, the way a dispatcher types it.
const SAID = {
  'all-in': 'is that all-in?',
  linehaul: 'what is the linehaul on it',
  'fuel-surcharge': 'any FSC on top?',
  rpm: 'I need $3.10/mi',
  deadhead: 'I am 80 miles deadhead',
  detention: 'detention after 2 hours?',
  layover: 'do you pay layover',
  tonu: 'what about TONU if it cancels',
  lumper: 'who covers the lumper',
  tolls: 'any tolls on that route',
  'rate-con': 'send the rate con',
  bol: 'BOL ready at pickup?',
  pod: 'I will send the POD',
  appointment: 'is there an appt at delivery',
  fcfs: 'is it FCFS?',
  'drop-and-hook': 'drop and hook at the shipper?',
  'live-load': 'is it a live unload',
  'pickup-number': 'what is the PU#',
  'quick-pay': 'do you do quick pay',
  factoring: 'we use a factoring company',
  reload: 'any reload out of there?',
  market: 'DAT shows more than that',
  temperature: 'what temp, 34F?',
  'pre-cool': 'I will pre-cool the box',
  continuous: 'continuous or start-stop?',
  tarps: 'does it need tarps',
  securement: 'how many straps',
}

// Kills: a pattern that no longer matches what it is for (a typo in a
// regex is silent: the word just stops counting), or a term added to the
// list with no example here.
test('every term is recognised in an ordinary sentence', () => {
  assert.deepEqual(Object.keys(SAID).sort(), FREIGHT_TERMS.map((t) => t.key).sort())
  for (const [key, sentence] of Object.entries(SAID)) {
    assert.ok(termsUsed(sentence).includes(key), `"${sentence}" should count as ${key}`)
  }
})

// Kills: patterns that are not whole-word, or too loose -- a student who
// writes in plain words must not be credited with the trade's.
test('plain words are not trade words', () => {
  const plain = [
    'hello, can I get this load?',
    'what is the rate',
    'the main factor is time',
    'I will call you back',
    'the driver is at Graceland',
  ]
  assert.deepEqual(termsUsed(plain), [])
  assert.deepEqual(termsUsed(''), [])
  assert.deepEqual(termsUsed([null, undefined]), [])
})

// Kills: fuel counted only by the exact phrase, when "all-in" or
// "linehaul" also settles whether fuel is in the number.
test('fuel counts as raised by any word that settles it', () => {
  for (const s of ['is that all-in?', 'what is the linehaul', 'any fuel surcharge?']) {
    const fuel = talkFacts([s], 'dry-van').confirm.find((c) => c.key === 'fuel')
    assert.equal(fuel.raised, true, s)
  }
})

// Kills: the same checklist for every trailer.
test('reefer adds temperature, flatbed adds securement, dry van adds nothing', () => {
  const keys = (eq) => confirmationsFor(eq).map((c) => c.key)
  assert.deepEqual(keys('dry-van'), ['appointment', 'fuel', 'detention', 'layover', 'lumper', 'tolls'])
  assert.ok(keys('reefer').includes('temperature'))
  assert.ok(keys('flatbed').includes('securement'))
  assert.ok(!keys('dry-van').includes('temperature'))
})

// Kills: counting the broker's words, or the rate confirmation document,
// as things the dispatcher said.
test('only the dispatcher\'s typed messages count', () => {
  const messages = [
    { role: 'broker', kind: 'text', content: 'it is all-in, detention after 2' },
    { role: 'dispatcher', kind: 'text', content: 'what about lumper' },
    { role: 'dispatcher', kind: 'rate_con', content: 'RATE CON with detention and tolls' },
  ]
  assert.deepEqual(dispatcherTexts(messages), ['what about lumper'])
  assert.deepEqual(talkFacts(dispatcherTexts(messages), 'dry-van').used, ['lumper'])
})

// Kills: the broker not told what the carrier said, or told it for a
// carrier who said nothing.
test('the broker hears which trade words the carrier used', () => {
  const pro = talkBlock(talkFacts(['all-in? I am 80 miles deadhead'], 'dry-van')).join('\n')
  assert.match(pro, /Trade words they have used: all-in, deadhead\./)
  const plain = talkBlock(talkFacts(['hello can I get it'], 'dry-van')).join('\n')
  assert.match(plain, /No trade words yet/)
  assert.deepEqual(talkBlock(null), [])
})

// Kills: the broker reciting accessorials unasked -- finding them out is
// the dispatcher's job.
test('the broker answers accessorials when asked and does not volunteer them', () => {
  const block = talkBlock(talkFacts([], 'dry-van')).join('\n')
  assert.match(block, /Do not bring these up yourself unless they\s+ask/)
})

// Kills: the block built but never put in the prompt.
test('the talk block reaches the system prompt', () => {
  const now = new Date('2026-10-05T15:00:00Z')
  const H = 3600000
  const posting = {
    id: 'p', originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX',
    distanceMi: 925, commodity: 'paper', weightLbs: 30000, equipmentType: 'dry-van', equipmentLengthFt: 53,
    rateHidden: false, rateUsd: 3300, postedAt: new Date(now - H), expiresAt: new Date(+now + 9 * H),
    pickupAt: new Date(+now + 30 * H), deliveryAt: new Date(+now + 50 * H),
  }
  const prompt = buildBrokerSystemPrompt({
    broker: { contactName: 'R K', name: 'X', persona: 'Calm.' }, posting, now,
    talk: talkFacts(['TONU if it cancels?'], 'dry-van'),
  })
  assert.match(prompt, /Trade words they have used: TONU\./)
})

// Kills: patterns that only match the way a manual writes a word. People
// type fast and lowercase in a chat ("dh", "fsc", "D&H", "all in", "pu#").
test('the way people actually type the words still counts', () => {
  const casual = {
    deadhead: 'im like 60 dh from there',
    'fuel-surcharge': 'any fsc?',
    'drop-and-hook': 'is it D&H',
    'all-in': 'that all in?',
    'pickup-number': 'send me the pu#',
    appointment: 'appt or no?',
    tonu: 'tonu if they cancel?',
  }
  for (const [key, sentence] of Object.entries(casual)) {
    assert.ok(termsUsed(sentence).includes(key), `"${sentence}" should count as ${key}`)
  }
})

// Kills: counting the dispatcher's words, or the rate confirmation document,
// as things the broker said (a figure on the rate con is not a raise).
test('only the broker\'s typed messages count as what the broker said', () => {
  const messages = [
    { role: 'broker', kind: 'text', content: 'it is all-in' },
    { role: 'dispatcher', kind: 'text', content: 'what about lumper' },
    { role: 'broker', kind: 'rate_con', content: 'RATE CON $5,000' },
  ]
  assert.deepEqual(brokerTexts(messages), ['it is all-in'])
  assert.deepEqual(brokerTexts(null), [])
})

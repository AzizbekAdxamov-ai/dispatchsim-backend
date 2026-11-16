// Clause-level reading of a dispatcher message (2026-11-15 live test):
// "Yes, let's book it." and "$4,000 all-in and we have a deal." were read as
// small talk because the whole message had to fit one phrase.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatIntent, negotiate, confirmBookLine } from '../src/modules/brokerChat/negotiation.js'
import { readClauses, classifySegment } from '../src/modules/brokerChat/clauseReading.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const QUOTE_USD = 3750
const ASK_USD = 4000
const POSTED_USD = 3600
const CONTACT = 'Dana Whitfield'
const posting = fakePosting({ rateUsd: POSTED_USD, distanceMi: 1500, contactName: CONTACT })
const rateSource = { rateUsd: POSTED_USD, rateBasis: 'all_in' }
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const MODES = Object.freeze([true, false])
const intentOf = (text, extra = {}) => chatIntent(text, rateSource, { contactName: CONTACT, ...extra })
const negotiating = () => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: QUOTE_USD })
const turn = (text, extra = {}) => negotiate({ conversation: negotiating(), posting, text, booking: matched, offerVisible: true, ...extra })

const ACCEPT_CORPUS = Object.freeze([
  "Yes, let's book it.", 'yes lets book it', 'Yes, book it.', "Let's book it", 'book it',
  "Sounds good, let's book it", "Perfect Dana, let's do it.", "Great, we'll take it.", 'Ok, send the rate con.',
  'Yeah that works, book it', "Thanks Dana, let's book it. Where do I send the MC?", "Yep, let's run it",
  'Ok we have a deal', 'Alright, deal.', 'Sounds good Dana.', 'Sure, send me the RC.',
])

// Kills: reading the whole message as one phrase (the prefix + "let's book it" combination fell to talk)
test('an acceptance phrase is accepted with any lead, vocative or trailing question', () => {
  for (const openNegotiation of MODES) {
    for (const text of ACCEPT_CORPUS) assert.equal(intentOf(text, { openNegotiation }).kind, 'accept', `${text} (open=${openNegotiation})`)
  }
})

// Kills: stripLead not removing the vocative (Dana) -- "Perfect Dana, let's do it." stayed other
test('a vocative after a lead word is dropped from the clause', () => {
  assert.equal(classifySegment("Perfect Dana, let's do it.", { contactName: CONTACT }), 'accept')
  assert.equal(classifySegment("Perfect Bob, let's do it.", { contactName: CONTACT }), 'accept')
})

// Kills: treating "Deal," after a lead as a vocative name (the accepting word was thrown away)
test('an accepting word after a lead is not mistaken for a name', () => {
  assert.equal(classifySegment('Ok Deal.'), 'accept')
})

const STRAIGHT = "Sounds good Dana, $4,000 all-in works. Let's book it. What do you need from me?"
// Kills: matching AMOUNT_FIRST only against the whole clause (the lead "Sounds good Dana," broke it)
test('a multi-sentence agreement reads the figure and the acceptance', () => {
  for (const text of [STRAIGHT, STRAIGHT.replaceAll("'", '’')]) {
    for (const openNegotiation of MODES) {
      const intent = intentOf(text, { openNegotiation })
      assert.equal(intent.kind, 'accept_amount', text)
      assert.equal(intent.rateUsd, ASK_USD)
    }
  }
  assert.equal(intentOf('$4,000 all-in works').kind, 'accept_amount')
  assert.equal(intentOf("Let's book it").kind, 'accept')
})

// Kills: a question segment cancelling the acceptance beside it
test('a question next to an acceptance does not cancel it', () => {
  assert.equal(readClauses("Let's book it. Where do I send the MC?").accepts, true)
  assert.equal(readClauses('Where do I send the MC?').accepts, false)
})

const CONDITIONAL_CLOSES = Object.freeze([
  '$4,000 all-in and we have a deal',
  'I appreciate it Dana. $4,000 all-in and we have a deal.',
  '$4,000 and it is a deal',
  '$4,000 all-in, we have a deal.',
])

// Kills: BOOK_WORD_RE hiding the bare figure (the close phrase must be set aside, not disable the figure)
test('a figure with a conditional close is read as an offer', () => {
  for (const text of [...CONDITIONAL_CLOSES, '$4,000 all-in']) {
    const intent = intentOf(text, { openNegotiation: true })
    assert.equal(intent.kind, 'offer', text)
    assert.equal(intent.rateUsd, ASK_USD, text)
  }
})

// Kills: counting a close phrase ("we have a deal") as an acceptance -- the broker would agree at 4000 instead of climbing the ladder
test('a conditional close does not book at the asked figure', () => {
  for (const text of CONDITIONAL_CLOSES) {
    const decision = turn(text)
    assert.equal(decision.state.agreed, null, text)
    assert.ok(decision.state.offer > QUOTE_USD, text)
    assert.ok(decision.state.offer < ASK_USD, text)
  }
})

// Kills: dropping the acceptance clause -- the quote on the table is not agreed
test('an acceptance settles the quote on the table', () => {
  for (const text of ["Yes, let's book it.", 'yes lets book it', 'Yeah that works, book it', "Perfect Dana, let's do it."]) {
    assert.equal(turn(text).state.agreed, QUOTE_USD, text)
  }
})

const REFUSALS = Object.freeze([
  "not yet, don't book it", "don't book it yet", "if the rate were 4000 let's book it", 'not sure, hold off',
  'no deal at $4,000', "if it were $4,000 we'd have a deal", "if you can do 4k we'll book it",
  "if the rate were 4000, let's book it", "unless Dana confirms, let's book it",
])
// "if you can do 4k we'll book it" is a conditional close by an older rule on purpose.
const NAMES_A_FIGURE = /^if you can do/
// Kills: ignoring the hypothetical veto when classifying clauses (the comma-split "let's book it" alone reads as an acceptance)
test('a refusal or a hypothetical is never an acceptance and never an offer', () => {
  for (const text of REFUSALS) {
    for (const openNegotiation of MODES) assert.notEqual(intentOf(text, { openNegotiation }).kind, 'accept', text)
    if (!NAMES_A_FIGURE.test(text)) assert.ok(!['offer', 'accept_amount'].includes(intentOf(text, { openNegotiation: true }).kind), text)
  }
})

// Kills: letting a veto in one clause stop applying when an acceptance sits in another
test('an acceptance beside a refusal is vetoed', () => {
  const reading = readClauses("Ok let's book it. Actually don't book it yet.")
  assert.equal(reading.vetoed, true)
  assert.equal(reading.accepts, false)
})

// Kills: a negation that is not about the booking ("I don't have the MC") vetoing a real acceptance
test('an unrelated negation does not veto an acceptance', () => {
  assert.equal(readClauses("Let's book it. I don't have the MC on me.").accepts, true)
})

const brokerAsk = confirmBookLine(`$${QUOTE_USD.toLocaleString('en-US')} all-in`)
// Kills: treating a bare "yes" as an acceptance without the broker's booking question before it
test('a bare yes answers the broker only when the broker asked to book', () => {
  for (const text of ['yes', 'yep', 'yes please']) {
    assert.equal(turn(text, { lastBrokerLine: brokerAsk }).intent.kind, 'accept', text)
    assert.equal(turn(text, { lastBrokerLine: brokerAsk }).state.agreed, QUOTE_USD, text)
    for (const context of ["What's your MC?", null, 'We can do $3,750 all-in.']) {
      assert.notEqual(turn(text, { lastBrokerLine: context }).intent.kind, 'accept', `${text} after ${context}`)
    }
  }
})

// Kills: affirm clauses counting without the broker question flag, or beside other content
test('a bare yes is not an acceptance on its own', () => {
  assert.equal(readClauses('yes').accepts, false)
  assert.equal(readClauses('yes', { affirmAccepts: true }).accepts, true)
  assert.equal(readClauses('Yes. Pickup is at 8am.', { affirmAccepts: true }).accepts, false)
})

// Kills: dropping the figure-plus-acceptance rule -- a figure beside a clear acceptance is only an offer
test('an acceptance beside a lone figure confirms that figure', () => {
  const intent = intentOf("I need $3,700 all-in. Let's book it.", { openNegotiation: true })
  assert.equal(intent.kind, 'accept_amount')
  assert.equal(intent.confirmsOffer, true)
  assert.equal(intent.rateUsd, 3700)
})

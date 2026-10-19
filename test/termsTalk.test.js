// The lumper-payer check: the broker's terms say the broker pays the lumper
// against a receipt, and a reply must not hand that cost to anyone else.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lumperPayerWrong, paymentTermsClaimed, PAYMENT_TERMS_LINE } from '../src/modules/brokerChat/termsTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { brokerReply } from '../scripts/scenarioChecks.js'

// Kills: the check missing the shipper (or receiver, consignee, you, the
// carrier) being named as the payer.
test('a lumper put on the shipper, receiver or carrier is flagged', () => {
  assert.equal(lumperPayerWrong('The shipper will cover any lumper fees with a receipt.'), true)
  assert.equal(lumperPayerWrong('Receiver handles the lumper, keep the receipt.'), true)
  assert.equal(lumperPayerWrong('Lumper is paid by the receiver.'), true)
  assert.equal(lumperPayerWrong('You pay the lumper and send the receipt.'), true)
})

// Kills: flagging the broker's own correct statement, which would
// regenerate good replies for nothing.
test('the broker paying the lumper is clean', () => {
  assert.equal(lumperPayerWrong('We cover any lumper cost with a receipt.'), false)
  assert.equal(lumperPayerWrong('You pay the lumper, we reimburse it against the receipt.'), false)
  assert.equal(lumperPayerWrong('Lumper is paid by the broker against a receipt.'), false)
})

// Kills: a payer word in a different sentence from the lumper being
// counted (the shipper loads you; the lumper is on us).
test('the payer is read within the sentence that mentions the lumper', () => {
  assert.equal(lumperPayerWrong('The shipper loads you at 8. Lumper is on us with a receipt.'), false)
  assert.equal(lumperPayerWrong('No lumper at this receiver.'), false)
  assert.equal(lumperPayerWrong(''), false)
})

// Kills: the check existing but never reaching the live regeneration, or
// naming the wrong term in the retry hint.
test('the broker reply check regenerates a wrong lumper payer with the real term', () => {
  const problem = brokerReplyProblem('The shipper will cover any lumper fees with a receipt.', {})
  assert.equal(problem.why, 'said someone other than you pays the lumper')
  assert.match(problem.hint, /Lumper: paid by the broker against a receipt/)
  assert.equal(problem.unusable, false)
  assert.equal(brokerReplyProblem('We cover any lumper cost with a receipt.', {}), null)
})

// Kills: the eval/scenario checks not seeing the finding (brokerFindings in
// evalCases.js goes through brokerReply).
test('the scenario check reports the lumper finding', () => {
  assert.ok(brokerReply('The shipper will cover any lumper fees with a receipt.', null).includes('lumper payer wrong'))
  assert.ok(!brokerReply('We cover any lumper cost with a receipt.', null).includes('lumper payer wrong'))
})

// Kills: a broker speaking in the first person singular ("I'll cover the
// lumper") read as someone else paying, so correct replies were regenerated.
test('"I" and "me" are the broker paying; repaying counts too', () => {
  assert.equal(lumperPayerWrong("I'll cover the lumper, you handle the receipt."), false)
  assert.equal(lumperPayerWrong('You will need to pay the lumper first, then I cover it.'), false)
  assert.equal(lumperPayerWrong('You pay the lumper and I repay it against the receipt.'), false)
  assert.equal(lumperPayerWrong('You cover the lumper and we pay you back.'), false)
  assert.equal(lumperPayerWrong('The shipper will cover any lumper fees with a receipt.'), true)
})

// -- Payment terms are accounting's ---------------------------------------------

const EB15 = "Yeah we do quick pay... the fee's just our standard accounting charge."
const POSTING = {
  id: 'p1', originCity: 'Dallas', destinationCity: 'Chicago', equipmentType: 'dry-van', rateUsd: 2400, distanceMi: 967, weightLbs: 30000,
}

// Kills: only a deferral word being looked for (EB15 passed because it
// says "accounting"): saying the broker DOES quick pay names a term.
test('paymentTermsClaimed: EB15 "we do quick pay" is flagged even with accounting in the next clause', () => {
  assert.equal(paymentTermsClaimed(EB15), true)
  assert.equal(paymentTermsClaimed("We do quick pay, the fee's just our standard accounting charge."), true)
})

// Kills: a denial excusing the topic: "we don't do quick pay" is still the
// broker stating a payment term (the prompt says never to say whether).
test('paymentTermsClaimed: denying quick pay is still naming a term', () => {
  assert.equal(paymentTermsClaimed("We don't do quick pay."), true)
  assert.equal(paymentTermsClaimed('There is no factoring here.'), true)
})

// Kills: payment days the carrier did not type passing as long as no "net"
// word is used ("7 days to pay is fine").
test('paymentTermsClaimed: payment days are flagged unless they are the carrier\'s own', () => {
  assert.equal(paymentTermsClaimed('7 days to pay is fine.'), true)
  assert.equal(paymentTermsClaimed('We usually pay within 30 days.'), true)
  assert.equal(paymentTermsClaimed("7 days to pay is accounting's call.", ['can u pay in 7 days?']), false)
  assert.equal(paymentTermsClaimed("7 days to pay is accounting's call.", 'can u pay in 7 days?'), false)
  // A different number than the one they typed is the broker's own.
  assert.equal(paymentTermsClaimed("15 days to pay is accounting's call.", ['can u pay in 7 days?']), true)
})

// Kills: a percentage passing because the clause defers to accounting.
test('paymentTermsClaimed: a percentage is never allowed, even when deferring', () => {
  assert.equal(paymentTermsClaimed("Accounting charges 3% for quick pay.", ['quick pay 3%?']), true)
  assert.equal(paymentTermsClaimed("That's accounting's, around 2 percent."), true)
})

// Kills: the lumper / detention fee talk being swept into payment terms (the
// lumper check owns it), which would throw away correct accessorial answers.
test('paymentTermsClaimed: accessorial fees are not payment terms; no payment talk is clean', () => {
  assert.equal(paymentTermsClaimed('Lumper fee is paid by the broker against a receipt.'), false)
  assert.equal(paymentTermsClaimed('Detention is $50 an hour after two hours, and TONU is $150.'), false)
  assert.equal(paymentTermsClaimed('Truck in Dallas by 6? Rate is $2,400 all-in.'), false)
  assert.equal(paymentTermsClaimed(''), false)
})

// Kills: the safe line being a reply the check itself flags (it would be
// thrown away and the holding line shown instead).
test('PAYMENT_TERMS_LINE passes the payment check and the full broker reply check', () => {
  assert.equal(paymentTermsClaimed(PAYMENT_TERMS_LINE), false)
  assert.equal(brokerReplyProblem(PAYMENT_TERMS_LINE, { posting: POSTING, text: 'can u pay in 7 days?', booking: null }), null)
})

// Kills: the live check not asking paymentTermsClaimed (or losing the
// accounting line): payment talk must end on the line, not be shown.
test('brokerReplyProblem: payment terms are unusable and fall back to the accounting line', () => {
  const p = brokerReplyProblem(EB15, { posting: POSTING, text: 'do you do quick pay?' })
  assert.equal(p.why, "named payment terms that are accounting's")
  assert.equal(p.unusable, true)
  assert.equal(p.safeReply, PAYMENT_TERMS_LINE)
  // Their own number, deferred, is fine; it is read from `said` when given.
  assert.equal(brokerReplyProblem("7 days to pay is accounting's call.", { text: 'ok', said: ['7 days?', 'ok'] }), null)
})

// Kills: the three rules the live checks enforce missing from the broker's
// prompt (the model is told first, the checks only catch what slips).
test('the broker prompt carries the payment, weight and phantom-booking rules', async () => {
  const { buildBrokerSystemPrompt } = await import('../src/modules/brokerChat/brokerChat.prompt.js')
  const prompt = buildBrokerSystemPrompt({ broker: { name: 'B', contactName: 'Dee', persona: 'p' }, posting: { ...POSTING, pickupAt: '2026-10-21T14:00:00Z' }, now: new Date('2026-10-18T12:00:00Z') })
  assert.match(prompt, /Never say whether you do quick pay/)
  assert.match(prompt, /The weight is what the load sheet says\. Never agree to more or less/)
  assert.match(prompt, /you have no record of that: say so\. Never confirm a booking or a\s+person you do not know about/)
})

// Kills: the "N business days to pay" wording slipping past the topic list
// (the invented-terms pattern only knows "N days to pay").
test('paymentTermsClaimed: business days to pay are flagged', () => {
  assert.equal(paymentTermsClaimed('We get you paid in 3 business days.'), true)
  assert.equal(paymentTermsClaimed('It is 3 business days to pay.'), true)
})

// Kills: fee / charge / percent / % counted as payment talk on their own
// ("no fee for the tarp", "100% on time" got the accounting line).
test('paymentTermsClaimed: a fee, charge or percentage with no payment talk is clean', () => {
  for (const reply of [
    'No fee on our side for the tarp.',
    'Rate is $2,000 all-in, no extra charge.',
    'Appointment fee? None.',
    'Pickup is 100% on time needed.',
    "There's a 5% fuel surcharge built in.",
  ]) {
    assert.equal(paymentTermsClaimed(reply), false, reply)
  }
})

// Kills: the payment-words gate dropped to nothing (a fee beside payment talk
// passes), or narrowed so "accounting" / "pay" no longer count.
test('paymentTermsClaimed: a fee, charge or percentage beside payment talk is flagged', () => {
  assert.equal(paymentTermsClaimed("They take a fee when you're paid."), true)
  assert.equal(paymentTermsClaimed("That's accounting's, around 2 percent."), true)
  assert.equal(paymentTermsClaimed('There is a 3% charge on payments.'), true)
})

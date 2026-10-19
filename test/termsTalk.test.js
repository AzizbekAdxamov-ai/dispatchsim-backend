// The lumper-payer check: the broker's terms say the broker pays the lumper
// against a receipt, and a reply must not hand that cost to anyone else.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lumperPayerWrong } from '../src/modules/brokerChat/termsTalk.js'
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

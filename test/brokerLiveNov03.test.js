// Live jonli test 2026-11-03 (chat_turn_log #109, #128): a wrong MC is
// answered with "not showing up, what's your correct MC?" and no rate
// confirmation that does not exist yet; the carrier is never asked for a
// stop address the broker gives on the paper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerReplyProblem, WRONG_MC_LINE } from '../src/modules/brokerChat/replyProblem.js'
import { mcGivenLines } from '../src/modules/brokerChat/brokerContext.js'

const posting = {
  originCity: 'Columbus', originState: 'OH', destinationCity: 'Detroit', destinationState: 'MI',
  rateUsd: 901, rateBasis: 'all-in', weightLbs: 22800, equipmentType: 'dry-van', distanceMi: 193,
}
const wrong = { mc: { said: '999999', verdict: 'mismatch' } }
const right = { mc: { said: '741309', verdict: 'match' } }
const noPaper = { status: 'open', delivered: false, stage: 'open' }

test('#109: citing a rate confirmation that does not exist yet is caught', () => {
  // Kills: citesMissingPaper removed -- the live reply passes untouched.
  const p = brokerReplyProblem('Your MC is 999999, which does not match the carrier MC listed on our rate confirmation.', {
    booking: wrong, posting, text: 'MC 999999', paper: noPaper })
  assert.equal(p?.why, 'referred to a rate confirmation that does not exist yet')
  assert.equal(p?.safeReply, WRONG_MC_LINE)
})

test('once the paper is delivered, citing it is fine', () => {
  // Kills: citesMissingPaper ignoring paper.delivered.
  const p = brokerReplyProblem('The pickup address is on the rate confirmation.', {
    booking: right, posting, text: 'where do i pick up', paper: { ...noPaper, delivered: true } })
  assert.notEqual(p?.why, 'referred to a rate confirmation that does not exist yet')
})

test('asking for the correct MC answers a wrong MC; it is not an identity form', () => {
  // Kills: the answersWrongMc exemption -- WRONG_MC_LINE itself would be
  // regenerated as 'asked for carrier identity before rate acceptance or booking'.
  const p = brokerReplyProblem(WRONG_MC_LINE, { booking: wrong, posting, text: 'MC 999999', paper: noPaper })
  assert.equal(p, null)
})

test('without an MC in their line, asking for one is still an identity form', () => {
  // Kills: an exemption that ignores what the dispatcher said.
  const p = brokerReplyProblem("What's your MC?", {
    booking: { mc: { said: null, verdict: null } }, posting, text: 'is the columbus load still available?', paper: noPaper })
  assert.equal(p?.why, 'asked for carrier identity before rate acceptance or booking')
})

test('#128: asking the carrier for the pickup address is caught, the rest is kept', () => {
  // Kills: asksCarrierForStop removed, or the fallback dropping the good sentence.
  const live = "Great, you're booked at $901 all-in and the rate confirmation will appear here for you to review and sign. Could you provide the exact pickup address in Columbus?"
  const p = brokerReplyProblem(live, { booking: right, posting, text: 'ok book it', paper: { ...noPaper, delivered: true }, bookedHere: true })
  assert.equal(p?.why, 'asked the carrier for a stop address you give them on the paper')
  assert.equal(p?.safeReply, "Great, you're booked at $901 all-in and the rate confirmation will appear here for you to review and sign.")
})

test('telling the carrier where the address is, is not asking for it', () => {
  // Kills: ASKS_STOP matching a statement with no question.
  const p = brokerReplyProblem("Pickup's in Columbus at 3:33 PM Central Time; the pickup address is on the paper.", {
    booking: right, posting, text: 'where is pu', paper: { ...noPaper, delivered: true } })
  assert.notEqual(p?.why, 'asked the carrier for a stop address you give them on the paper')
})

test('the prompt gets an MC line only when their line gives an MC', () => {
  // Kills: mcGivenLines ignoring the verdict or firing on every turn.
  assert.match(mcGivenLines('MC 999999', wrong).join(' '), /does not come up.*correct MC.*no rate confirmation yet/)
  assert.match(mcGivenLines('MC 741309', right).join(' '), /checks out/)
  assert.deepEqual(mcGivenLines('is it still available?', wrong), [])
})

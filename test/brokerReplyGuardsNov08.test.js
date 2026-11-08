// Release 2026-11-08, band 4b: reply guards and the repeat guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { negotiate, confirmBookLine, NOT_BOOKED_CANCEL_LINE } from '../src/modules/brokerChat/negotiation.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { paperClaimProblem } from '../src/modules/brokerChat/paperTalk.js'
import { quoteText } from '../src/modules/brokerChat/rateQuote.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import {
  replySimilarity, repeatsRecent, varyRepeat, REPEAT_LEADS, REPEAT_LOOKBACK, REPEAT_SIMILARITY_THRESHOLD,
} from '../src/modules/brokerChat/repeatGuard.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const open = (extra = {}) => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd, ...extra })
const turn = (text, conversation = open(), extra = {}) =>
  negotiate({ conversation, posting, text, booking: matched, offerVisible: true, ...extra })

// Kills: removing re-?send from the claim and outgoing patterns ("Resending the rate confirmation to x@y.com" passed)
test('resending the rate confirmation is a delivery claim when none has arrived', () => {
  const paper = { status: 'open', delivered: false }
  assert.ok(paperClaimProblem('Resending the rate confirmation to x@y.com.', paper))
  assert.ok(paperClaimProblem('The rate confirmation went out to both of you.', paper))
  assert.equal(paperClaimProblem('did the rc go out?', paper), null)
})

// Kills: dropping the already-has-an-email guard (the broker asked "Which email?" after it was given)
test('asking which email to use is refused when the thread already has one', () => {
  const decision = turn('deal', open(), { knownEmail: 'dispatch@example.com' })
  assert.equal(decision.issuePaper, true)
  const problem = brokerReplyProblem('$3,500 confirmed. Which email should I use?', { posting, negotiation: decision, text: 'deal', booking: matched })
  assert.equal(problem?.unusable, true)
  assert.match(problem.why, /email the dispatcher already gave/)
  assert.equal(problem.safeReply, decision.line)
  // With no email on file, asking is exactly right.
  const asking = turn('deal')
  assert.equal(brokerReplyProblem('$3,500 agreed. What email should I put on the rate confirmation?', { posting, negotiation: asking, text: 'deal', booking: matched }), null)
})

// Kills: dropping the bare-acknowledgement guard (live reply "Noted." to a message with the MC and driver)
test('a bare "Noted." to booking details with nothing agreed is replaced by a confirm question', () => {
  const text = 'My driver is Sam, ok'
  const decision = turn(text)
  const problem = brokerReplyProblem('Noted.', { posting, negotiation: decision, text, booking: matched })
  assert.equal(problem?.unusable, true)
  assert.equal(problem.safeReply, confirmBookLine(quoteText(posting, decision.state.offer)))
  // Small talk with no booking details is left alone.
  assert.equal(brokerReplyProblem('Noted.', { posting, negotiation: turn('thanks'), text: 'thanks', booking: matched }), null)
})

// Kills: dropping the cancel + on-hold guard ("cancelled and remains on hold")
test('a cancel is never answered as cancelled and on hold', () => {
  const decision = turn('cancel it')
  const reply = 'Okay, the load is cancelled and remains on hold.'
  const problem = brokerReplyProblem(reply, { posting, negotiation: decision, text: 'cancel it', booking: matched })
  assert.equal(problem?.unusable, true)
  assert.equal(problem.safeReply, NOT_BOOKED_CANCEL_LINE)
  // The same sentence after a real hold is not flagged by this guard.
  const hold = turn('hold off for now')
  assert.doesNotMatch(brokerReplyProblem('Fine, it stays on hold.', { posting, negotiation: hold, text: 'hold off for now', booking: matched })?.why ?? '', /cancelled and on hold/)
})

const B3_FIRST = 'Our current quote remains $1,700 all-in for this lane. Let me know if you want to move forward.'
const B3_SECOND = 'Our current quote remains $1,700 all-in for this lane. Let me know if you would like to move forward.'

// Kills: similarity threshold raised above 1 (nothing ever counts as a repeat)
test('near-identical replies are a repeat and different ones are not', () => {
  assert.equal(replySimilarity(B3_FIRST, B3_FIRST), 1)
  assert.ok(replySimilarity(B3_FIRST, B3_SECOND) >= REPEAT_SIMILARITY_THRESHOLD)
  assert.ok(replySimilarity(B3_FIRST, 'Pickup is at the Dallas yard, dock 4, at 8 in the morning.') < REPEAT_SIMILARITY_THRESHOLD)
  // A different figure is a different reply.
  assert.ok(replySimilarity('I can do $1,700 all-in.', 'I can do $1,850 all-in.') < 1)
  assert.equal(repeatsRecent(B3_SECOND, [B3_FIRST]), true)
})

// Kills: REPEAT_LOOKBACK set to 0 (the previous reply is never compared)
test('only the last replies are compared', () => {
  assert.ok(REPEAT_LOOKBACK >= 1)
  const older = ['Pickup is at 8.', 'Delivery is Friday.', B3_FIRST]
  assert.equal(repeatsRecent(B3_SECOND, older), true)
  assert.equal(repeatsRecent(B3_SECOND, [B3_FIRST, ...older.slice(0, REPEAT_LOOKBACK)]), false)
})

// Kills: varyRepeat returning the line unchanged for a repeat
test('a repeated line always comes back reworded and never with the lead just used', () => {
  const varied = varyRepeat(B3_SECOND, [B3_FIRST])
  assert.notEqual(varied, B3_SECOND)
  assert.ok(REPEAT_LEADS.some((lead) => varied.startsWith(lead)))
  const again = varyRepeat(B3_SECOND, [varied])
  assert.ok(!again.startsWith(REPEAT_LEADS.find((lead) => varied.startsWith(lead))))
  // New text is left alone.
  assert.equal(varyRepeat('Dock 4, 8 am.', [B3_FIRST]), 'Dock 4, 8 am.')
  // An identical line, any capital start.
  assert.notEqual(varyRepeat("I can't do more.", ["I can't do more."]), "I can't do more.")
})

// Kills: the repeat check missing from brokerReplyProblem (no regeneration for a copy of the last reply)
test('a copy of the last reply is flagged once, as a content problem', () => {
  const problem = brokerReplyProblem(B3_SECOND, { brokerSaid: [B3_FIRST] })
  assert.match(problem.why, /repeated your previous reply/)
  assert.equal(problem.unusable, false)
  assert.equal(brokerReplyProblem(B3_SECOND, { brokerSaid: [] }), null)
})

// Kills: varyRepeat not applied in the service (a regeneration that stays identical went out as is)
test('the service regenerates a repeated reply once and then leads it in', async () => {
  const fake = makeFakeBrokerRepo({ posting, lines: [] })
  let calls = 0
  const same = 'Our current quote remains $3,500 all-in on this one.'
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => { calls += 1; return same } }
  const send = (text) => sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text }, { deps })
  await send('Is it still available?')
  fake.deliverAll()
  assert.equal(calls, 1)
  await send('Is it still available?')
  assert.equal(calls, 3, 'one more call for the second turn plus one regeneration')
  const last = fake.state.messages.filter((m) => m.role === 'broker').at(-1)
  assert.ok(REPEAT_LEADS.some((lead) => last.content.startsWith(lead)), last.content)
})

// Kills: listMessages dropping the voided guard or the rate-con figures (card showed no amount)
test('listMessages carries the paper figures only on a live rate con', () => {
  const source = readFileSync(new URL('../src/modules/brokerChat/brokerChat.repository.js', import.meta.url), 'utf8')
  const listing = source.slice(source.indexOf('export async function listMessages'), source.indexOf('export async function hasPendingReply'))
  for (const column of ['rate_con_rate_usd END AS "rateConRateUsd"', 'rate_con_basis END AS "rateConBasis"', 'rate_con_fuel_surcharge_usd END AS "rateConFuelSurchargeUsd"']) {
    assert.ok(listing.includes(`CASE WHEN m.kind = 'rate_con' AND m.voided_at IS NULL THEN c.${column}`), column)
  }
  assert.ok(listing.includes('m.voided_at AS "voidedAt"'))
  assert.ok(listing.includes('m.deliver_at <= now()'), 'an undelivered rate con must stay hidden')
})

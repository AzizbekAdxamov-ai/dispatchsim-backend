// Release 2026-11-08, band 4a: "book it" phrasings, cancel is not a hold,
// an email given early is kept, and an ask above the ceiling is not booked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  chatIntent, negotiate, lastAuthorizedEmail, confirmBookLine, NOT_BOOKED_CANCEL_LINE, AGREEMENT_DROPPED_LINE,
} from '../src/modules/brokerChat/negotiation.js'
import { quoteText } from '../src/modules/brokerChat/rateQuote.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const open = (extra = {}) => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd, ...extra })
const turn = (text, conversation = open(), extra = {}) =>
  negotiate({ conversation, posting, text, booking: matched, offerVisible: true, ...extra })

// Kills: removing AMOUNT_BOOK -- these were read as talk and the model said "Noted."
test('an amount with a booking word confirms the quote on the table', () => {
  for (const text of ['yes $3500 all in, book it', '3500 works book it', 'ok 3500 deal', 'book it at 3500']) {
    assert.equal(chatIntent(text).kind, 'accept_amount', text)
    assert.equal(turn(text).state.agreed, 3500, text)
  }
})

// Kills: letting confirmsOffer settle above the broker's own quote ("yes 3800 book it" booked at 3800)
test('an amount above the quote with a booking word is an ask, not a booking', () => {
  const decision = turn('yes 3800 book it')
  assert.equal(decision.state.agreed, null)
  assert.ok(decision.state.pushes >= 1)
  assert.match(decision.line, /I can offer|Best I can do/)
})

// Kills: AMOUNT_BOOK without a required accept word ("3500 all in" alone becoming a booking)
test('an amount with no booking word is not a confirmation', () => {
  assert.notEqual(chatIntent('3500 all in').kind, 'accept_amount')
  assert.notEqual(chatIntent('yes 3500').kind, 'accept_amount')
})

// Kills: dropping the confirm-book fallback -- the figure and booking word fell through to no line at all
test('a figure and a booking word nothing could place is asked about, not noted', () => {
  const decision = turn('ok 3500 sounds whatever works lol')
  assert.equal(decision.state.agreed, null)
  assert.equal(decision.line, confirmBookLine(quoteText(posting, 3500)))
  // No amount, no question.
  assert.equal(turn('that works lol').line === confirmBookLine(quoteText(posting, 3500)), false)
})

// Kills: cancel read as a hold again (stage 'held', "cancelled and remains on hold")
test('cancel with nothing booked is not a hold', () => {
  for (const text of ['cancel', 'cancel it', 'cancel this load']) {
    assert.equal(chatIntent(text).kind, 'cancel', text)
    const decision = turn(text)
    assert.equal(decision.line, NOT_BOOKED_CANCEL_LINE, text)
    assert.equal(decision.state.stage, 'negotiating', text)
    assert.equal(decision.state.agreed, null, text)
  }
  assert.equal(chatIntent('I will hold off on this').kind, 'hold')
  assert.equal(chatIntent('cancel it for 3400').kind !== 'cancel', true)
  assert.equal(chatIntent("don't cancel it").kind !== 'cancel', true)
})

// Kills: an agreed-but-unsigned rate surviving a cancel
test('cancel after an agreed rate drops the agreement and voids the paper', () => {
  const decision = turn('cancel it', open({ status: 'agreed', negotiationStage: 'paper_pending', agreedRateUsd: 3500, recipientEmail: 'a@b.com' }))
  assert.equal(decision.state.agreed, null)
  assert.equal(decision.state.recipient, null)
  assert.equal(decision.state.stage, 'negotiating')
  assert.equal(decision.invalidatePaper, true)
  assert.equal(decision.line, AGREEMENT_DROPPED_LINE)
})

// Kills: next-turn email lookup ignoring earlier messages (X5: "What email?" asked twice)
test('an email given before the agreement is used when the rate is agreed', () => {
  const texts = ['Put it on dispatch@example.com please.', 'what is the rate?']
  assert.equal(lastAuthorizedEmail(texts), 'dispatch@example.com')
  assert.equal(lastAuthorizedEmail(['hi', 'ok']), null)
  // Newest authorised address wins.
  assert.equal(lastAuthorizedEmail(['send the rate con to old@example.com', 'send the rate con to new@example.com']), 'new@example.com')
  // A hypothetical is not authorisation.
  assert.equal(lastAuthorizedEmail(['If needed, put it on dispatch@example.com.']), null)

  const known = turn('deal', open(), { knownEmail: 'dispatch@example.com' })
  assert.equal(known.issuePaper, true)
  assert.equal(known.state.recipient, 'dispatch@example.com')
  const unknown = turn('deal')
  assert.equal(unknown.issuePaper, false)
  assert.match(unknown.line, /What email/)
})

// Kills: restoring the unconditional agree for accept_amount ("book it at 9000" booked at 9000)
test('an acceptance above the ceiling goes to the ladder, not to a booking', () => {
  const above = ceilingFor(posting) + 500
  for (const text of [`book it at ${above}`, `if you can do ${above}`]) {
    const decision = turn(text)
    assert.equal(decision.state.agreed, null, text)
    assert.equal(decision.state.pushes, 1, text)
    assert.ok(decision.state.offer <= ceilingFor(posting), text)
  }
  // Inside the ceiling it still settles.
  assert.equal(turn(`book it at ${ceilingFor(posting)}`).state.agreed, ceilingFor(posting))
})

// Kills: dropping "voided_at IS NULL" -- after void and re-agree no new rate con row was ever written
test('the rate-con insert only looks at rate cons that are not voided', () => {
  const source = readFileSync(new URL('../src/modules/brokerChat/brokerChat.repository.js', import.meta.url), 'utf8')
  assert.match(source, /WHERE NOT EXISTS \(SELECT 1 FROM broker_messages WHERE conversation_id = \$1 AND kind = 'rate_con' AND voided_at IS NULL\)/)
  assert.match(source, /\['hold', 'walk', 'push', 'cancel'\]\.includes\(intent\.kind\)/)
})

// Kills: lastAuthorizedEmail skipping past a retraction to an older address
test('a retracted or conditional email does not revive the older one', () => {
  assert.equal(lastAuthorizedEmail(['send the rate con to a@b.com', "actually don't send it to a@b.com"]), null)
  assert.equal(lastAuthorizedEmail(['send the rate con to a@b.com', 'If needed, put it on c@d.com.']), null)
  // A message that names no email does not settle anything.
  assert.equal(lastAuthorizedEmail(['send the rate con to a@b.com', 'what is the pickup time']), 'a@b.com')
  // The newest message that names an email wins.
  assert.equal(lastAuthorizedEmail(["don't send it to a@b.com", 'send the rate con to c@d.com']), 'c@d.com')
})

// Kills: a hold or cancel leaving the older address reachable (the repository clears the recipient on those)
test('a hold or cancel after an email clears it', () => {
  assert.equal(lastAuthorizedEmail(['send the rate con to a@b.com', 'hold off on the rate con']), null)
  assert.equal(lastAuthorizedEmail(['send the rate con to a@b.com', 'cancel it']), null)
  assert.equal(lastAuthorizedEmail(['hold off', 'send the rate con to a@b.com']), 'a@b.com')
})

// Kills: the email tail leaving ", email" behind so AMOUNT_BOOK fails and only a confirm question is asked
test('a booking phrase followed by an email instruction still agrees', () => {
  for (const text of ['3500 book it, email a@b.com', '3500 book it, send the rate con to a@b.com', 'ok 3500 deal, my email is a@b.com']) {
    const decision = turn(text)
    assert.equal(decision.state.agreed, 3500, text)
  }
  // Authorised address on the same line goes straight onto the paper.
  const decision = turn('3500 book it, send the rate con to a@b.com')
  assert.equal(decision.issuePaper, true)
  assert.equal(decision.state.recipient, 'a@b.com')
})

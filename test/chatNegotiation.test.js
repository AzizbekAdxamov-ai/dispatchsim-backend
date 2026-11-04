import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent, negotiate, negotiationReplyProblem, bookingTurn } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { bookingFacts, saysBooked } from '../src/modules/brokerChat/bookingTalk.js'
import { carrierEmail } from '../src/modules/carrier/carrier.repository.js'
import { updateCarrierSchema } from '../src/modules/carrier/carrier.schemas.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 1571, distanceMi: 442, weightLbs: 42000 })
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }
const initial = { status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: 1571 }
const step = (text, conversation = initial, extra = {}) => negotiate({ conversation, posting, text, booking, offerVisible: true, ...extra })
const saved = (decision) => ({ ...initial, status: decision.state.agreed === null ? 'open' : 'agreed',
  negotiationStage: decision.state.stage, brokerOfferUsd: decision.state.offer,
  agreedRateUsd: decision.state.agreed, recipientEmail: decision.state.recipient,
  ratePushCount: decision.state.pushes, bestCounterUsed: decision.state.bestCounterUsed })

test('street-style meet-me asks remain bounded offers, never implicit acceptance', () => {
  const exact = '8153 kinda low bro im like 250 miles out can u meet me at 8700?'
  assert.equal(chatIntent(exact).rateUsd, 8700)
  assert.equal(chatIntent(exact).kind, 'offer')
  for (const text of ['could you meet us at $8700?', 'can you meet me at 8,700?']) assert.equal(chatIntent(text).rateUsd, 8700)
  for (const text of ['If you can u meet me at 8700, I might take it.', 'I cant meet you at 8700.',
    'He said "can u meet me at 8700".', 'Can u meet me at 8700 miles?', 'Can u meet me at 8700-9000?',
    'Can u meet me at $8700 or $9000?']) assert.ok(!['offer', 'accept_amount', 'accept'].includes(chatIntent(text).kind), text)
  const load = { ...posting, id: '4cbdd03f-96f8-4e20-b2f4-14557092473a', rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 }
  const result = negotiate({ conversation: { brokerOfferUsd: 8153, ratePushCount: 1 }, posting: load, text: exact, booking })
  // Kills: the verified deadhead reason advances two ladder steps.
  assert.equal(result.state.offer, 8328)
  assert.equal(result.state.agreed, null)
  assert.equal(result.issuePaper, false)
  assert.equal(bookingTurn(exact, result), false)
  assert.equal(chatIntent('8153 kinda low brother').kind, 'push')
})

test('apostropheless holds and negations stay active without mutating recipient addresses or quoted examples', () => {
  for (const text of ['hold up bro dont book nothing yet, gotta check with my driver',
    'dont book anything yet', 'gotta check my driver', 'dont book yet and I cant confirm',
    'I didnt say book it bro, dont book nothing yet', 'I am not sure, hold up bro',
    "don't book yet, I'll confirm after checking", 'don’t book yet, I’ll confirm after checking']) assert.equal(chatIntent(text).kind, 'hold', text)
  for (const text of ['He said "dont book anything yet".', "He said 'dont book anything yet'.", 'If I say dont book, what happens?',
    'I wont hold off.', 'dont cancel it.', 'didnt say book it bro, just tell me pickup n delivery times',
    'cant accept $1571', 'wont take it at $1571']) {
    assert.ok(!['hold', 'accept', 'accept_amount', 'offer'].includes(chatIntent(text).kind), text)
    assert.equal(bookingTurn(text), false, text)
  }
  assert.equal(chatIntent('book it').kind, 'accept')
  assert.equal(chatIntent('that rate works').kind, 'accept')
  assert.deepEqual(chatIntent('dont@example.com').emails, ['dont@example.com'])
  assert.deepEqual(chatIntent('Please send it to cant@example.com.').emails, ['cant@example.com'])
})

test('availability with a passive booking invitation is safe, accomplished booking claims remain blocked per occurrence', () => {
  const decision = step('Is the load still open?')
  for (const reply of ['It is still open and ready to be booked.', 'This load can be booked.',
    'The load is not booked yet.']) assert.equal(brokerReplyProblem(reply, { posting, booking: { mc: { verdict: null } }, text: 'Is it still open?', negotiation: decision }), null, reply)
  for (const reply of ['I booked it for you.', 'It is booked for you.', "You're booked.",
    'You are not far away so I booked it',
    'It is still open and ready to be booked, and I booked it for you.',
    'The load is not booked yet, but I booked it for you.']) assert.ok(negotiationReplyProblem(reply, decision), reply)
})

test('an MC request does not excuse a present booking claim; a future MC-dependent step remains conditional', () => {
  const decision = step('Deal.', initial, { booking: { mc: { verdict: null } } })
  for (const reply of ['Send me your MC, we have it booked.', 'Give me your MC and I have it booked for you.',
    'Send your MC and I have it booked for you.']) {
    assert.equal(saysBooked(reply), true, reply)
    assert.ok(negotiationReplyProblem(reply, decision), reply)
  }
  for (const reply of ['Send your MC and we will get it booked after that.',
    'Give me your MC and I will have it booked after that.',
    'If your MC checks out, we can get it booked.']) {
    assert.equal(saysBooked(reply), false, reply)
    assert.equal(negotiationReplyProblem(reply, decision), null, reply)
  }
  const mixed = 'Send your MC and we will get it booked after that. I already have it booked for you.'
  assert.equal(saysBooked(mixed), true)
  assert.ok(negotiationReplyProblem(mixed, decision))
})

test('carrier request attribution is occurrence-local and cannot authorize another payment or agreement', () => {
  const load = { ...posting, rateUsd: 8153, distanceMi: 2180 }
  const decision = negotiate({ conversation: {}, posting: load, text: 'brother can you 9000$', booking, offerVisible: true })
  for (const reply of [
    // Kills: first pressure is now STEP_1, so the authoritative counter is $8,553.
    'I understand you’re looking for $9,000. Our all-in rate for this load is $8,553. Please let me know.',
    'You asked for $9,000, but I can offer $8,553 all-in.',
    'Your $9,000 ask makes sense. I am at $8,553 all-in.',
    'You requested 9000; my offer is 8553 all-in.',
  ]) assert.equal(negotiationReplyProblem(reply, decision), null, reply)
  for (const reply of [
    'You asked for $9,000; I can do $9,000 all-in.',
    'You asked for $9,000 and I can pay $9,000.',
    'Your requested $9,000 works.',
    'Your $9,000 ask works.',
    'We agree to your $9,000.',
    'Our offer is your $9,000 ask.',
    'I can match your $9,000 ask.',
    'Your requested rate $9,000 is approved.',
    'Your requested rate $9,000, which is approved.',
    'Your requested $9,000 sounds good.',
    'I’ll pay your requested rate $9,000.',
    'We’ll pay your requested rate $9,000.',
    'You asked $9,000, and I will pay that.',
    'You asked $9,000, and I’ll pay that.',
    'You asked $9,000. That is approved.',
    'You asked $9,000. That works.',
    'Our offer is $9,000 per load.',
    'Our offer is $9,000 per trip.',
    'I can pay $9,000 if you book.',
    'You asked for $8,700. My offer is $8,153.',
    '$9,000.',
    'You asked for $9,000. Deal.',
  ]) assert.ok(negotiationReplyProblem(reply, decision), reply)
  // Kills: authoritative first-push quote is the STEP_1 amount, not the post rate.
  assert.equal(negotiationReplyProblem('My rate is $8,553 all-in. Detention $85/hr after 2 hours free.', decision), null)
  assert.equal(negotiationReplyProblem('You asked $9,000. My offer is $8,553. I will pay that.', decision), null)
})

test('only explicit monetary intention becomes an offer or acceptance', () => {
  for (const text of ['Can you do $1,800?', 'I need 1800 all-in.', 'How about 1,800?', 'I can take it for $1800.']) assert.equal(chatIntent(text).rateUsd, 1800, text)
  for (const text of ['1800', '$1800', 'MC-741309', 'Call 214-555-0110', 'Pickup 10/21 at 6:14', 'Truck 1800', 'Weight 1800 lbs',
    'We need 1800 lbs capacity', 'Can you do 1800 miles?', 'If you can do $1800, I might take it.',
    'I cannot accept $1800.', 'I do not agree to $1800.', 'He said "I accept $1800".', 'What if I accept $1800?',
    'Our email is dispatch1800@example.com', 'I need 1800-555-0110']) {
    assert.ok(!['offer', 'accept_amount', 'accept'].includes(chatIntent(text).kind), text)
  }
  assert.equal(chatIntent('Can you do $1700 or $1800?').kind, 'ambiguous')
})

test('informal suffix-dollar offers and low-rate objections retain their intent safely', () => {
  for (const text of ['brother can you 9000$', 'can u 9000', 'could you do $9,000']) {
    assert.deepEqual(chatIntent(text), { kind: 'offer', rateUsd: 9000, emails: [], useOwnEmail: false }, text)
  }
  for (const text of ['8100 to low brother can u add litle bit or what is your best', 'can u add a little bit?', 'what is your best?']) {
    assert.equal(chatIntent(text).kind, 'push', text)
  }
  for (const text of ['If you can you 9000$, I might take it.', 'I cannot do 9000$', 'He said "can you 9000$".', 'Can u 9000 miles?', 'Can you 9000$ per hour?']) {
    assert.ok(!['offer', 'accept_amount', 'accept'].includes(chatIntent(text).kind), text)
  }
})

test('ordinary haggling earns one bounded counter without MC and cannot ratchet or issue paper', () => {
  const load = { ...posting, id: '4cbdd03f-96f8-4e20-b2f4-14557092473a', rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 }
  const unverified = { mc: { verdict: null } }
  let conversation = { ...initial, brokerOfferUsd: load.rateUsd }
  const ask = (text, extra = {}) => negotiate({ conversation, posting: load, text, booking: unverified, offerVisible: true, ...extra })
  let decision = ask('brother can you 9000$')
  // Kills: STEP_1_SHARE applies on the first unverified pressure.
  // Kills: STEP_1 is derived from this posting's deterministic ceiling.
  assert.equal(decision.state.offer, 8678)
  conversation = saved(decision)
  decision = ask('8100 to low brother can u add litle bit or what is your best')
  // Kills: reverting first-push STEP_1 movement would leave the old posted rate.
  // Kills: the second push reaches STEP_2 from the first STEP_1 counter.
  assert.equal(decision.state.offer, 8978)
  assert.equal(brokerReplyProblem(decision.line, { posting: load, booking: unverified, text: 'what is your best?', negotiation: decision }), null)
  for (let n = 0; n < 5; n += 1) {
    conversation = saved(decision)
    decision = ask('Can you add a little bit?')
    // Kills: the third pressure is the ceiling and must stop moving.
    assert.equal(decision.state.offer, 9650)
    assert.equal(decision.state.agreed, null)
    assert.equal(decision.issuePaper, false)
    assert.ok(decision.state.offer <= ceilingFor(load))
  }
  const accept = ask('Deal.')
  assert.equal(accept.state.agreed, null)
  // Kills: asking for a "correct" MC before any number was supplied.
  assert.equal(accept.line, "What's your MC?")
  assert.equal(bookingTurn('Deal.', accept), true)
  for (const text of ['My driver is Ethan Brooks', 'Truck number IL-2048-EB', 'ops@example.com']) {
    assert.equal(bookingTurn(text, ask(text)), false, text)
  }
  // Kills: a lower explicit figure is a booking request that still requires MC; it is not paper issuance.
  assert.equal(bookingTurn('Need $9000', ask('Need $9000')), true)
  const wrong = ask('Can you add a little bit?', { booking: { mc: { verdict: 'mismatch' } } })
  // Kills: resetting an already reached ceiling on a later pressure.
  assert.equal(wrong.state.offer, ceilingFor(load))
  assert.equal(wrong.state.agreed, null)
})

test('MC questions wait for acceptance while authorized prices and reason guards stay authoritative', () => {
  const missing = { mc: { verdict: null } }
  const hello = step('wassap brother', initial, { booking: missing })
  const premature = brokerReplyProblem('May I have your MC number?', { posting, booking: missing, text: 'wassap brother', negotiation: hello })
  assert.equal(premature.unusable, true)
  assert.match(premature.safeReply, /^Hey!/)
  for (const text of ['What is the rate?', 'My driver is Ethan Brooks', 'Can you do $1800?']) {
    const decision = step(text, initial, { booking: missing })
    assert.equal(brokerReplyProblem('Please provide your MC.', { posting, booking: missing, text, negotiation: decision }).unusable, true)
  }
  const accepted = step('Deal.', initial, { booking: missing })
  assert.equal(brokerReplyProblem(accepted.line, { posting, booking: missing, text: 'Deal.', negotiation: accepted }), null)
  const wrong = { mc: { verdict: 'mismatch' } }
  const price = step('Can you do $1800?', initial, { booking: wrong })
  assert.equal(brokerReplyProblem('Please give me the correct MC.', { posting, booking: wrong, text: 'Can you do $1800?', negotiation: price }).unusable, true)
  assert.equal(step('Deal.', initial, { booking: wrong }).issuePaper, false)
})

test('validated lower offers allow required MC while objections and invalid figures do not', () => {
  const load = { ...posting, rateUsd: 8153, distanceMi: 2180 }
  for (const verdict of [null, 'match']) {
    const identity = { mc: { verdict }, trailer: { fits: true } }
    const ask = (text) => negotiate({ conversation: { ...initial, brokerOfferUsd: 8153 }, posting: load,
      text, booking: identity, offerVisible: true })
    for (const text of ['Can you do 8100?', 'I need 8100', 'brother can you 8100$']) {
      const decision = ask(text)
      assert.equal(decision.intent.kind, 'offer')
      assert.equal(bookingTurn(text, decision), true, text)
      assert.equal(brokerReplyProblem(decision.line, { posting: load, booking: identity, text, negotiation: decision }), null)
      assert.equal(decision.state.agreed, verdict === 'match' ? 8100 : null)
      assert.equal(decision.issuePaper, false)
      // Kills: calling an absent MC incorrect (Azizbek qarori 2026-11-04).
      if (verdict !== 'match') assert.equal(decision.line, "What's your MC?")
    }
    for (const text of ['Can you do 100?', 'I accept 100.', 'I accept 20000.', 'Can you do 20000?',
      '8100 to low brother can u add litle bit or what is your best']) {
      const decision = ask(text)
      assert.equal(bookingTurn(text, decision), false, text)
      assert.equal(decision.state.agreed, null, text)
      assert.equal(decision.issuePaper, false, text)
      assert.equal(brokerReplyProblem('Please provide your MC.', { posting: load, booking: identity, text, negotiation: decision }).unusable, true)
    }
  }
})

test('valid current offer acceptance needs no forced bargaining; email alone cannot agree', () => {
  assert.equal(step('dispatch@example.com').state.agreed, null)
  const agreement = step("I'll take it at $1,571.")
  assert.equal(agreement.state.stage, 'awaiting_email')
  assert.equal(agreement.state.agreed, 1571)
  assert.equal(agreement.issuePaper, false)
  const email = step('Please send the rate confirmation to dispatch@example.com.', saved(agreement))
  assert.equal(email.issuePaper, true)
  assert.equal(email.state.recipient, 'dispatch@example.com')
  assert.equal(email.state.stage, 'paper_pending')
  assert.equal(step('dispatch@example.com', saved(email)).issuePaper, false)
})

test('an unquoted bare yes does not silently accept a hidden initial offer', () => {
  assert.equal(step('Deal.', initial, { offerVisible: false }).state.agreed, null)
  assert.equal(step('Deal.').state.agreed, 1571)
})

test('account email is authorized explicitly and never exposed on an ordinary introduction', () => {
  assert.deepEqual(carrierEmail({ email: null }, { email: 'personal@example.com' }), { effectiveEmail: 'personal@example.com', emailSource: 'account' })
  assert.equal(carrierEmail({ email: 'dispatch@example.com' }, { email: 'personal@example.com' }).effectiveEmail, 'dispatch@example.com')
  const hello = step('Hello.', initial, { effectiveEmail: 'personal@example.com' })
  assert.equal(hello.state.recipient, null)
  const accepted = step('Deal.')
  const email = step('Use my email.', saved(accepted), { effectiveEmail: 'personal@example.com' })
  assert.equal(email.state.recipient, 'personal@example.com')
  assert.equal(email.issuePaper, true)
  assert.equal(updateCarrierSchema.parse({ email: null }).email, null)
  assert.equal(updateCarrierSchema.parse({ email: ' Dispatch@Example.com ' }).email, 'dispatch@example.com')
  assert.throws(() => updateCarrierSchema.parse({ email: 'bad' }))
})

test('hold and changed price invalidate a paper; a repeated email does not create another', () => {
  const accepted = step('Deal.')
  const paper = step('dispatch@example.com', saved(accepted))
  const held = step("Please don't book or issue the rate confirmation yet.", saved(paper))
  assert.equal(held.invalidatePaper, true)
  assert.equal(held.state.stage, 'held')
  assert.equal(held.state.agreed, null)
  assert.equal(held.state.recipient, null)
  assert.equal(held.issuePaper, false)
  const counter = step('Actually I need $1800.', saved(paper))
  assert.equal(counter.state.agreed, null)
  assert.equal(counter.invalidatePaper, true)
})

test('first push holds, grounded later push moves partway, huge requests never become agreement', () => {
  const first = step('Need $1800 for the heavy weight.')
  // Kills: a verified reason starting at the posted rate (T2 #208: reasoned 2,578 < unreasoned 2,603).
  // The unreasoned first push earns the first rung (1646); the reasoned one the second rung on top of it.
  assert.equal(step('Need $1800.').state.offer, 1646)
  assert.equal(first.state.offer, 1696)
  assert.equal(first.state.agreed, null)
  const second = step('Need $1800 for the heavy weight.', saved(first))
  assert.ok(second.state.offer > 1646)
  assert.ok(second.state.offer <= ceilingFor(posting))
  // Kills: a second grounded push may reach the named ceiling.
  assert.ok(second.state.offer <= ceilingFor(posting))
  assert.equal(step('I accept $45678.').state.agreed, null)
  assert.ok(step('Need $1800.', saved(first)).state.offer > 1646)
  const walk = step("I'll pass.")
  const again = step("I'll pass.", saved(walk))
  assert.equal(walk.state.bestCounterUsed, true)
  assert.equal(again.state.offer, walk.state.offer)
})

test('wrong MC, mismatched trailer and unreachable pickup cannot authorize agreement', () => {
  assert.equal(step('Deal.', initial, { booking: { mc: { verdict: 'mismatch' } } }).state.agreed, null)
  assert.equal(step('Deal.', initial, { booking: { mc: { verdict: 'match' }, trailer: { fits: false } } }).state.agreed, null)
  assert.equal(step('Deal.', initial, { truck: { makesIt: false } }).state.agreed, null)
  const accepted = saved(step('Deal.'))
  assert.equal(step('dispatch@example.com', accepted, { booking: { mc: { verdict: 'mismatch' } } }).issuePaper, false)
})

test('model prose cannot invent a rate or acceptance or leak the observed inner dialogue', () => {
  const decision = step('What is the rate?')
  assert.ok(negotiationReplyProblem('$1900 all-in works.', decision))
  assert.ok(negotiationReplyProblem('I can do 1900 all-in.', decision))
  assert.ok(negotiationReplyProblem('Rate confirmed: $1571 all-in.', decision))
  assert.ok(negotiationReplyProblem('We have a deal at 1571 all-in. What is your email?', decision))
  assert.ok(negotiationReplyProblem('Agreed at 1571 all-in. Send your email.', decision))
  for (const reply of ['We have a deal at $1,571 all-in. What is your email?',
    'Agreed at $1,571 all-in. Send your email.', 'I accept your offer of $1,571 all-in. What is your email?',
    'Deal, $1,571 all-in. What is your email?', '$1,571 all-in confirmed. What email?']) {
    assert.equal(brokerReplyProblem(reply, { negotiation: decision, posting, text: 'Is it available?' })?.unusable, true)
  }
  for (const reply of ['No deal at $1,571 yet.', 'If $1,571 works, we can have a deal.',
    'Is $1,571 all-in agreed?', 'The rate is $1,571 all-in. Is the pickup confirmed?']) {
    assert.equal(negotiationReplyProblem(reply, decision), null, reply)
  }
  assert.equal(negotiationReplyProblem('$1571 all-in. Detention $85/hr after two hours.', decision), null)
  assert.equal(brokerReplyProblem('Understood. We need to ask for email now? Actually they said not to book yet.', {}).unusable, true)
  assert.equal(brokerReplyProblem('No driver assist needed. [No further response needed]', {}).unusable, true)
})

test('accessorial charge questions cannot become a linehaul handshake', () => {
  for (const text of ['Can you pay $500 detention?', 'Can you pay $1800 detention?',
    'Can you do $500 layover?', 'Need $500 for driver-assist.', 'I accept $500 detention.']) {
    assert.equal(step(text).state.agreed, null, text)
  }
})

test('only a recipient instruction or an email-only answer authorizes paper', () => {
  const accepted = saved(step('Deal.'))
  for (const text of ['Is dispatch@broker.com your email?', 'The shipper contact is shipper@example.com.',
    'He said "send it to quote@example.com".', 'Do not send it to wrong@example.com.',
    'If I use other@example.com, is that okay?']) {
    assert.equal(step(text, accepted).issuePaper, false, text)
  }
  for (const text of ['dispatch@example.com', 'My email is dispatch@example.com.',
    'Please send the rate confirmation to dispatch@example.com.']) {
    assert.equal(step(text, accepted).issuePaper, true, text)
  }
})

test('combined acceptance keeps the rate but never bypasses recipient clause authorization', () => {
  for (const tail of ['Do not use old@example.com.', 'If needed, send it to old@example.com.',
    'The shipper contact is shipper@example.com.', 'Is dispatch@broker.com your email?',
    'He said "send it to old@example.com".', 'Should I use my email?']) {
    const decision = step(`I accept $1571. ${tail}`)
    assert.equal(decision.state.agreed, 1571, tail)
    assert.equal(decision.state.stage, 'awaiting_email', tail)
    assert.equal(decision.issuePaper, false, tail)
    assert.equal(decision.state.recipient, null, tail)
  }
  const positive = step('I accept $1571. Please send the rate confirmation to dispatch@example.com.')
  assert.equal(positive.issuePaper, true)
  assert.equal(positive.state.recipient, 'dispatch@example.com')
  const own = step('I accept $1571. Use my email.', initial, { effectiveEmail: 'account@example.com' })
  assert.equal(own.state.recipient, 'account@example.com')
})

test('a plain low-rate objection holds first, later grounded push moves, and passing withdraws paper', () => {
  const first = step('That is too low.')
  // Kills: plain first pressure also moves by STEP_1_SHARE.
  assert.equal(first.state.offer, 1646)
  assert.equal(first.state.pushes, 1)
  const second = step('Can you do better for this heavy weight?', saved(first))
  assert.ok(second.state.offer > 1646)
  const accepted = step('Deal.')
  const paper = step('Use my email.', saved(accepted), { effectiveEmail: 'a@example.com' })
  assert.equal(step("I'll pass.", saved(paper)).state.stage, 'held')
  assert.equal(step('Cancel.', saved(paper)).state.agreed, null)
})

test('live carrier introduction and operational questions preserve company, driver and trailer', () => {
  const carrier = { name: 'Keystone Line Haul', mcNumber: 'MC-741309' }
  const facts = bookingFacts({ carrier, posting, texts: [
    'Hi Renata, this is Keystone Line Haul, MC-741309. Calling about Rockford to Columbus.',
    'Our truck is in Chicago, IL with a 53-foot dry van.',
    'The driver is Ethan Brooks, truck IL-2048-EB.',
    'Is any driver assist required? I will confirm the driver’s ETA before we book.',
    'No extra equipment?', 'What are the detention terms?', 'Thanks.', 'That works.',
  ] })
  assert.equal(facts.company, carrier.name)
  assert.equal(facts.driverName, 'Ethan Brooks')
  assert.equal(facts.trailer.lengthFt, 53)
  assert.equal(facts.truck.city, 'Chicago')
})


test('future approval conditions keep recipient unauthorized without losing a separate price acceptance', () => {
  const accepted = saved(step('Deal.'))
  for (const clause of ['Send it to ops@example.com after I confirm.',
    'Send it to ops@example.com when driver confirms.', 'Send it to ops@example.com once driver confirms.',
    'Send it to ops@example.com until I approve.',
    'After I confirm the driver and approve the truck, send it to ops@example.com.']) {
    for (const conversation of [initial, accepted]) {
      const result = step(`I accept $1571. ${clause}`, conversation)
      assert.equal(result.state.agreed, 1571, clause)
      assert.equal(result.state.recipient, null, clause)
      assert.equal(result.state.stage, 'awaiting_email', clause)
      assert.equal(result.issuePaper, false, clause)
    }
    assert.equal(step(clause, accepted).issuePaper, false, clause)
  }
  for (const text of ['Send it to ops@example.com when you get a chance.',
    "Send it to ops@example.com when it's ready.",
    'Send it to ops@example.com. After I confirm the driver, I will call the shipper.']) {
    assert.equal(step(text, accepted).issuePaper, true, text)
  }
})

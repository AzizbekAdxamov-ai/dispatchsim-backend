import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent, negotiate, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
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
  assert.equal(first.state.offer, 1571)
  assert.equal(first.state.agreed, null)
  const second = step('Need $1800 for the heavy weight.', saved(first))
  assert.ok(second.state.offer > 1571)
  assert.ok(second.state.offer <= ceilingFor(posting))
  assert.ok(second.state.offer < 1800)
  assert.equal(step('I accept $45678.').state.agreed, null)
  assert.equal(step('Need $1800.', saved(first)).state.offer, 1571)
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
  assert.equal(first.state.offer, 1571)
  assert.equal(first.state.pushes, 1)
  const second = step('Can you do better for this heavy weight?', saved(first))
  assert.ok(second.state.offer > 1571)
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

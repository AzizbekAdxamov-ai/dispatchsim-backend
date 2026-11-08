// What the broker says once the load is booked: pure policy, no database.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  loadStage, LOAD_STAGES, postBookingDecision, troubleIntent, paymentIntent,
  TROUBLE_ACCIDENT_LINES, ABANDON_WINDOW_MESSAGES,
} from '../src/modules/brokerChat/postBookingPolicy.js'
import { WAIT_ETA_LINE } from '../src/modules/brokerChat/blockPolicy.js'

const NOW = new Date('2026-11-08T18:00:00Z')
const RATE = 3100
const BASE = {
  id: '600010', status: 'ontime', dispatchedAt: '2026-11-08T10:00:00Z', deliveredAt: null,
  rateUsd: RATE, accessorials: [], invoiceDueAt: null, invoicePaidAt: null, daysToPay: 30,
}
const BOOKED = { ...BASE, status: 'neutral', dispatchedAt: null }
const DELIVERED = { ...BASE, status: 'done', deliveredAt: '2026-11-08T16:00:00Z', invoiceDueAt: '2026-12-08T16:00:00Z' }

const decide = (text, { load = BASE, thread = [], openEvent = null } = {}) => postBookingDecision({
  stage: loadStage(load), text, thread, load, openEvent, now: NOW,
})
const dollars = (line) => [...line.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replaceAll(',', '')))
const broker = (content) => ({ role: 'broker', content })

// Kills: delivered state read from status only (deliveredAt with an ontime status read as in transit)
test('loadStage: deliveredAt wins over an ontime status; dispatched means in transit', () => {
  assert.equal(loadStage({ ...BASE, deliveredAt: '2026-11-08T16:00:00Z' }), LOAD_STAGES.DELIVERED)
  assert.equal(loadStage(BASE), LOAD_STAGES.IN_TRANSIT)
  assert.equal(loadStage(BOOKED), LOAD_STAGES.BOOKED)
  assert.equal(loadStage({ status: 'cancelled' }), LOAD_STAGES.CANCELLED)
})

// Kills: an accident message treated as a cancellation (block on the first call-in) or a rate haggle
test('an accident call-in on the road gets safety questions, raises an accident, never a block', () => {
  const d = decide('driver had an accident, we cant deliver, find someone else')
  assert.equal(d.action, 'trouble')
  assert.equal(d.eventType, 'accident')
  assert.match(d.line, /driver/i)
  assert.match(d.line, /okay|hurt/i)
  assert.deepEqual(dollars(d.line), [])
  assert.ok(TROUBLE_ACCIDENT_LINES.some((l) => d.line.includes(l)))
})

// Kills: STRONG_CANCEL "truck broke down ... can't do it" blocking a carrier mid-run
test('"truck broke down, can\'t do it" on the road is trouble, not a block', () => {
  const d = decide("truck broke down, can't do it")
  assert.equal(d.action, 'trouble')
  assert.equal(d.eventType, 'breakdown')
})

// Kills: abandon never reached (broker accepts being abandoned) or reached on the first message
test('after the broker answered the trouble, "cancel it, find someone else" is an abandon', () => {
  const first = decide('truck broke down')
  const thread = [{ role: 'dispatcher', content: 'truck broke down' }, broker(first.line)]
  const d = decide('cancel it, find someone else', { thread })
  assert.equal(d.action, 'abandon')
  assert.match(d.line, /Don't call this desk again/)
})

// Kills: the recovery question repeated word for word on the second trouble message
test('a second trouble message asks for the recovery ETA instead of repeating', () => {
  const first = decide('truck broke down')
  const again = decide('truck broke down again', { thread: [broker(first.line)] })
  assert.equal(again.action, 'trouble')
  assert.match(again.line, /recovery truck/i)
  assert.notEqual(again.line, first.line)
})

// Kills: hypothetical guard dropped (a "what if" raising a real accident)
test('"if the truck breaks down" is not trouble; "won\'t start" still is', () => {
  assert.deepEqual(troubleIntent('what do I do if the truck breaks down?'), { kind: null, abandons: false })
  assert.deepEqual(troubleIntent('no accident, all good'), { kind: null, abandons: false })
  assert.equal(troubleIntent("truck won't start").kind, 'breakdown')
})

// Kills: an open event not being named in the broker's line
test('with an open event the broker names where the truck is stopped', () => {
  const d = decide('truck broke down', { openEvent: { place: 'Amarillo, TX' } })
  assert.match(d.line, /Amarillo, TX/)
})

// Kills: booked cancel/wait path broken by the new route (block / ask_eta / reclaim)
test('on a booked load, cancel blocks and wait asks for an ETA, then takes the load back', () => {
  assert.equal(decide('cancel it', { load: BOOKED }).action, 'block')
  const wait = decide('can u wait', { load: BOOKED })
  assert.equal(wait.action, 'ask_eta')
  assert.equal(wait.line, WAIT_ETA_LINE)
  assert.equal(decide('can u wait', { load: BOOKED, thread: [broker(WAIT_ETA_LINE)] }).action, 'reclaim')
})

// Kills: calling cancellationDecision on a delivered load (withdrawAgreement would cancel/block)
test('on a delivered load "cancel it" is told there is nothing to cancel', () => {
  assert.equal(decide('cancel it', { load: DELIVERED }).action, 'delivered_no_cancel')
})

// Kills: rate talk after booking changing or quoting any figure but the signed rate
test('a rate change request at any stage answers rate_locked with the signed rate only', () => {
  for (const load of [BOOKED, BASE, DELIVERED]) {
    const d = decide('can u do 3500 instead', { load })
    assert.equal(d.action, 'rate_locked')
    assert.deepEqual([...new Set(dollars(d.line))], [RATE])
  }
})

// Kills: payment reply quoting a made-up figure, omitting the due date, or hinting at the credit rating
test('a payment question before the due date quotes only the invoice amount and the due date', () => {
  const d = decide('when do i get paid?', { load: DELIVERED })
  assert.equal(d.action, 'payment')
  assert.deepEqual([...new Set(dollars(d.line))], [RATE])
  assert.match(d.line, /Dec 8, 2026/)
  assert.match(d.line, /accounting/i)
  assert.doesNotMatch(d.line, /credit|rating/i)
})

// Kills: broker approving or inventing detention that is not on the paper
test('detention that is not on the invoice is neither approved nor priced', () => {
  const d = decide('detention 4 hrs', { load: DELIVERED })
  assert.equal(d.action, 'payment')
  assert.deepEqual(dollars(d.line), [])
  assert.match(d.line, /isn't on the rate con or the invoice/)
  assert.match(d.line, /accounting/i)
  assert.doesNotMatch(d.line, /approved|we owe/i)
})

// Kills: detention amount read from anywhere but the recorded accessorial
test('detention that is on the invoice is quoted at the recorded amount', () => {
  const load = { ...DELIVERED, accessorials: [{ label: 'Detention 3h', amountUsd: 195 }] }
  assert.match(decide('what about detention', { load }).line, /\$195/)
})

// Kills: paid and past-due invoices sounding like not-yet-due ones
test('paid shows the paid date; past due is flagged to accounting', () => {
  const paid = decide('did you pay me', { load: { ...DELIVERED, invoicePaidAt: '2026-11-20T18:00:00Z' } })
  assert.match(paid.line, /paid on Nov 20, 2026/)
  const late = postBookingDecision({
    stage: LOAD_STAGES.DELIVERED, text: 'where is my money', thread: [], load: DELIVERED, now: new Date('2027-01-15T00:00:00Z'),
  })
  assert.match(late.line, /past due/i)
  assert.match(late.line, /flag it to accounting/)
})

// Kills: a legal threat falling into the generic reply instead of calm facts and accounting
test('a legal threat gets a calm reply with the invoice facts and accounting', () => {
  assert.equal(paymentIntent('ill sue u').legal, true)
  const d = decide('ill sue u if i dont get paid', { load: DELIVERED })
  assert.equal(d.action, 'payment')
  assert.match(d.line, /I hear you|Understood/)
  assert.match(d.line, /accounting/i)
  assert.doesNotMatch(d.line, /help desk|hotline/i)
})

// Kills: no line rotation (same message twice, same sentence twice)
test('the same message twice gets two different lines', () => {
  const first = decide('ok thanks', { load: DELIVERED })
  const second = decide('ok thanks', { load: DELIVERED, thread: [broker(first.line)] })
  assert.notEqual(first.line, second.line)
})

// Kills: payment talk read when no payment word is present
test('paymentIntent ignores a plain rate message', () => {
  assert.deepEqual(paymentIntent('can u do 3500 instead'), { asks: false, detention: false, charge: null, legal: false })
})

// Kills: blockPolicy's short negation list letting "haven't had an accident" raise a real accident
test('denied trouble is not trouble, but "can\'t deliver, truck broke down" still is', () => {
  assert.equal(troubleIntent("we haven't had an accident").kind, null)
  assert.equal(troubleIntent("truck wasn't damaged").kind, null)
  assert.equal(troubleIntent("we can't deliver, truck broke down").kind, 'breakdown')
})

// Kills: missing trouble phrases (a flat tire, a deer, a hurt driver treated as plain chat)
test('flat tire, deer, towed and a hurt driver are trouble; a hurt driver is an accident', () => {
  assert.equal(troubleIntent('we have a flat tire').kind, 'breakdown')
  assert.equal(troubleIntent('we got towed').kind, 'breakdown')
  assert.equal(troubleIntent('hit a deer on 40').kind, 'accident')
  assert.equal(troubleIntent('driver is in the hospital').kind, 'accident')
  assert.equal(troubleIntent('driver got hurt').kind, 'accident')
})

// Kills: charge type ignored (a lumper question answered with the detention accessorial)
test('a lumper question is not answered with a detention charge', () => {
  const load = { ...DELIVERED, accessorials: [{ label: 'Detention 3h', amountUsd: 195 }] }
  const d = decide('can i get the lumper reimbursed', { load })
  assert.deepEqual(dollars(d.line), [])
  assert.match(d.line, /That charge isn't on the rate con or the invoice/)
  const withLumper = { ...DELIVERED, accessorials: [{ label: 'Lumper', amountUsd: 80 }] }
  assert.match(decide('lumper fee?', { load: withLumper }).line, /Lumper of \$80 is on the invoice/)
})

// Kills: an old trouble reply, long ago, turning a later "cancel it" into an abandon
test('a trouble reply far back in the thread does not make a later cancel an abandon', () => {
  const first = decide('truck broke down')
  const filler = Array.from({ length: ABANDON_WINDOW_MESSAGES }, () => ({ role: 'dispatcher', content: 'ok' }))
  const d = decide('cancel it, find someone else', { thread: [broker(first.line), ...filler] })
  assert.equal(d.action, 'block')
  const recent = decide('cancel it, find someone else', { thread: [broker(first.line), ...filler.slice(1)] })
  assert.equal(recent.action, 'abandon')
})

// Kills: a clause-wide denial hiding real trouble ("hit a deer, driver wasn't hurt" read as denied)
test('a denial only reaches the term right after it; real trouble wins', () => {
  assert.equal(troubleIntent("hit a deer, driver wasn't hurt").kind, 'accident')
  assert.equal(troubleIntent("we haven't had an accident").kind, null)
  assert.equal(troubleIntent("truck wasn't damaged").kind, null)
  assert.equal(troubleIntent("we can't deliver, truck broke down").kind, 'breakdown')
  assert.equal(troubleIntent('no accident, just a flat tire').kind, 'breakdown')
  assert.equal(troubleIntent('no problem, truck broke down').kind, 'breakdown')
})

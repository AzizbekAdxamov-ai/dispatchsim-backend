import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blockUntil, cancellationIntent, cancellationResponse, shouldBlock,
  cancellationDecision, CANCELLABLE_STATUSES, WAIT_ETA_LINE,
} from '../src/modules/brokerChat/blockPolicy.js'

test('explicit cancellation blocks only an agreed or booked load', () => {
  assert.equal(cancellationIntent("truck broke down, can't cover").kind, 'cancel')
  assert.equal(shouldBlock({ status: 'booked', cancellationText: 'release it' }), true)
  assert.equal(shouldBlock({ status: 'open', cancellationText: 'release it' }), false)
})

test('wait with no ETA returns the load without a block', () => {
  assert.equal(cancellationIntent('truck is not working, can you wait?').kind, 'wait')
  assert.match(cancellationResponse({ noEta: true }), /another truck/i)
  assert.equal(shouldBlock({ status: 'booked', cancellationText: 'no ETA' }), false)
})

test('block duration uses the named default', () => {
  const start = new Date('2026-11-04T00:00:00Z')
  assert.equal(blockUntil(start).toISOString(), '2026-11-11T00:00:00.000Z')
})

// ── 2026-11-05 broker fixes ──────────────────────────────────────────────
const decide = (text, status = 'agreed', brokerSaid = []) => cancellationDecision({ status, text, brokerSaid })

// Kills: live T7 Northgate block "I cant cover that rate, can u do 3400?"
test('a rate negotiation or a hypothetical is never a cancellation', () => {
  for (const text of [
    'I cant cover that rate, can u do 3400?',
    "I can't cover that rate, can u do 3400?",
    "can't do $3400",
    'can u do 3400',
    'tonu if they cancel?',
    'dont cancel it',
    'what is the cancel fee',
    'if u cant do 3400 ill cancel it',
    "truck broke down, can't cover it for 3400",
  ]) {
    assert.notEqual(cancellationIntent(text).kind, 'cancel', text)
    assert.equal(decide(text)?.action === 'block', false, text)
  }
})

// Kills: real cancel -- T5 "sorry my truck broke down, cancel it, find another truck", EB25, S10
test('a real cancellation of an agreed load still blocks', () => {
  for (const text of [
    'sorry my truck broke down, cancel it, find another truck',
    "truck broke down, I can't cover — cancel it",
    "truck broke down, I can't cover it — cancel the load",
    "truck broke down, I can't cover",
    'release it',
    'can u cancel it?',
  ]) {
    assert.equal(decide(text)?.action, 'block', text)
  }
})

// Kills: "can u wait" not recognized -- live T6 #239/#240 "Can you wait for me?"
test('asking for time: ask the ETA first, take the load back when there is none', () => {
  for (const text of [
    'can u wait',
    'can you wait for me',
    'Hey so sorry for that but my driver just told me his truck is not working well. Can you wait for me?',
  ]) {
    assert.deepEqual(decide(text), { action: 'ask_eta', line: WAIT_ETA_LINE }, text)
  }
  for (const text of ['no eta yet', 'I have no ETA yet']) {
    const d = decide(text)
    assert.equal(d.action, 'reclaim', text)
    assert.match(d.line, /another truck/i)
  }
  assert.equal(decide('can u wait', 'agreed', [WAIT_ETA_LINE]).action, 'reclaim')
  assert.equal(decide('eta 3 hrs, can u wait'), null)
})

// Kills: "Marcus Oyelaran: …" prefix doubled in the thread
test('policy lines carry no speaker prefix', () => {
  for (const line of [cancellationResponse(), cancellationResponse({ noEta: true }), WAIT_ETA_LINE]) {
    assert.doesNotMatch(line, /^[A-Z][\w .'-]*:\s/)
  }
})

// Kills: a cancel phrase on an open thread blocking the broker
test('policy applies only to agreed or booked loads', () => {
  assert.equal(decide('cancel it', 'open'), null)
  assert.equal(decide('cancel it', 'agreed').action, 'block')
  assert.equal(decide('cancel it', 'booked').action, 'block')
  assert.deepEqual([...CANCELLABLE_STATUSES], ['agreed', 'booked'])
})

// Kills: reviewer 2026-11-05 -- every "can't cover it at that rate" style haggle was blocking
test('a message that talks price is never a cancellation', () => {
  for (const text of [
    "I can't cover it at that rate",
    'cant cover it at this rate',
    "can't cover it with that rate",
    "can't cover this load at that price",
    "can't cover it, too low",
    "can't cover it, need more money",
    "I can't cover it for less",
    "can't cover it below 3400",
    "sorry, cant cover it at that rate",
    'cancel it for that price',
    'sorry cant cover it at that',
    "I can't cover it at that rate. Cancel it.",
  ]) {
    assert.notEqual(cancellationIntent(text).kind, 'cancel', text)
    assert.equal(decide(text), null, text)
  }
})

// Kills: reviewer 2026-11-05 -- the price guard swallowing a real breakdown cancel
test('a breakdown, "find another truck" or "release it" still blocks without any price talk', () => {
  for (const text of [
    'truck broke down, cancel it, find another truck',
    "truck broke down, I can't cover — cancel it",
    "truck broke down, I can't cover it — cancel the load",
    'find another truck',
    'release it',
  ]) {
    assert.equal(decide(text)?.action, 'block', text)
  }
})

// Kills: reviewer 2026-11-05 -- "can u wait" straight to reclaim after the carrier gave an ETA
test('after the carrier gives an ETA, a new "can u wait" asks again instead of reclaiming', () => {
  const thread = (...rest) => [
    { role: 'dispatcher', content: 'can u wait' },
    { role: 'broker', content: WAIT_ETA_LINE },
    ...rest,
  ]
  const gaveEta = thread({ role: 'dispatcher', content: 'eta 3 hrs' })
  assert.equal(cancellationDecision({ status: 'agreed', text: 'can u wait', brokerSaid: [WAIT_ETA_LINE], thread: gaveEta }).action, 'ask_eta')
  const noEta = thread({ role: 'dispatcher', content: 'still checking' })
  assert.equal(cancellationDecision({ status: 'agreed', text: 'can u wait', brokerSaid: [WAIT_ETA_LINE], thread: noEta }).action, 'reclaim')
})

// Kills: reviewer pass 2 -- "find another truck" inside a haggle blocked ("can u do 3400, otherwise find another truck")
test('"find another truck" next to a price is a threat, not a cancellation', () => {
  for (const text of [
    'can u do 3400, otherwise find another truck',
    'cant do 2000 find another truck',
    'I cant cover that rate, can u do 3400?',
    "can't cover it below 3400",
    'can u do 3400 or i cancel',
  ]) {
    assert.notEqual(cancellationIntent(text).kind, 'cancel', text)
    assert.equal(decide(text), null, text)
  }
  assert.equal(decide('sorry my truck broke down, cancel it, find another truck')?.action, 'block')
})

// Kills: reviewer pass 2 -- a bare digit read as a price ("cancel load 4521" never blocked)
test('identifiers, hours and distances are not prices', () => {
  for (const text of [
    'cancel load 4521',
    'cancel the load 4521',
    'cancel the load #4521',
    "cancel it, truck is 2 hrs away and broke",
    'cancel it, 150 miles out and cant make it',
    'cancel it, order 123456',
    'cancel it, truck 12 broke',
    'cancel it, truck is down for 2 hrs',
    'cancel it, 600 miles out',
  ]) {
    assert.equal(decide(text)?.action, 'block', text)
  }
})

// Kills: reviewer pass 2 -- a figure or k-figure in a haggle not recognised as a price
test('figures in a price context are prices', () => {
  for (const text of ['cancel it for 3.4k', 'cancel it at 80', 'cancel it, do 2900', 'cancel it $3400', 'cancel it for 3,400']) {
    assert.equal(decide(text), null, text)
  }
})

// Kills: reviewer pass 2 -- each price signal on its own (symbol, k-figure, "do 80", bare 4-digit figure)
test('every price signal alone keeps the cancel phrase from blocking', () => {
  for (const text of ['cancel it, $5', 'cancel it, 3k', 'cancel it, do 80', 'cancel it, 2900 is my number']) {
    assert.equal(decide(text), null, text)
  }
})

// Cancel booking from the load page through the real service with an
// in-memory repo: the broker's own booked-thread policy decides, the model is
// never called.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cancelBookingForLoad, sendMessage, CANCEL_BOOKING_TEXT } from '../src/modules/brokerChat/brokerChat.service.js'
import { RECLAIM_LINE } from '../src/modules/brokerChat/blockPolicy.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const LOAD = {
  id: '600010', status: 'neutral', dispatchedAt: null, deliveredAt: null,
  rateUsd: 3100, accessorials: [], invoiceDueAt: null, invoicePaidAt: null, daysToPay: 30, openEvent: null,
}
const IN_TRANSIT = { ...LOAD, status: 'ontime', dispatchedAt: '2026-11-08T10:00:00Z' }

function setup(load, { threadStatus = 'booked' } = {}) {
  const fake = makeFakeBrokerRepo({ posting: fakePosting({ status: 'booked' }), lines: ['hello'] })
  fake.forceAgreed(3100)
  fake.state.conversation.status = threadStatus
  fake.state.load = load
  const deps = {
    repo: fake.repo,
    getCarrier: async () => ({}),
    chatText: async () => { throw new Error('model must not be called') },
    assertCanSend: async () => { throw new Error('budget must not be touched') },
    reportRoadEvent: async () => {},
  }
  return { fake, deps }
}
const cancel = (t, loadId = LOAD.id, userId = FAKE_IDS.user) => cancelBookingForLoad({ loadId, userId }, { deps: t.deps })

// Kills: CANCEL_BOOKING_TEXT reworded without "this load" -> policy says ack, nothing is cancelled
test('a booked, unassigned load: the broker is told, blocked and the load is cancelled', async () => {
  const t = setup(LOAD)
  const res = await cancel(t)
  assert.equal(res.cancelled, true)
  assert.equal(t.fake.state.blocks.length, 1)
  assert.equal(t.fake.state.messages.at(-2).content, CANCEL_BOOKING_TEXT)
})

// Kills: an in-flight load's cancel text read as trouble/ack instead of block
test('a load in transit is cancelled the same way, not answered as trouble', async () => {
  const t = setup(IN_TRANSIT)
  const res = await cancel(t)
  assert.equal(res.cancelled, true)
  assert.equal(res.loadStage, 'in_transit')
  assert.equal(t.fake.state.blocks.length, 1)
})

// Kills: delivered loads reaching cancelAndBlock (block + void with the load left alone)
test('a delivered load is refused before any message is written', async () => {
  const t = setup({ ...LOAD, status: 'done', deliveredAt: '2026-11-08T12:00:00Z' })
  const before = t.fake.state.messages.length
  await assert.rejects(cancel(t), { code: 'LOAD_NOT_CANCELLABLE' })
  assert.equal(t.fake.state.messages.length, before)
  assert.equal(t.fake.state.blocks.length, 0)
})

// Kills: an already-cancelled load being cancelled again (second block, second message)
test('an already cancelled load is refused', async () => {
  const t = setup({ ...LOAD, status: 'cancelled' })
  await assert.rejects(cancel(t), { code: 'LOAD_NOT_CANCELLABLE' })
  assert.equal(t.fake.state.blocks.length, 0)
})

// Kills: a thread that is no longer booked still taking a cancel
test('a thread that is not booked any more is refused', async () => {
  const t = setup(LOAD, { threadStatus: 'open' })
  await assert.rejects(cancel(t), { code: 'LOAD_NOT_CANCELLABLE' })
})

// Kills: answering for a load the user did not book
test('no broker thread for this user: LOAD_HAS_NO_BROKER_THREAD', async () => {
  const t = setup(LOAD)
  await assert.rejects(cancel(t, LOAD.id, 'someone-else'), { code: 'LOAD_HAS_NO_BROKER_THREAD' })
})

// Kills: a block from another load trapping this booking (BROKER_BLOCKED) or adding a second block row
test('blocked by another load: the booking is still cancelled, no second block', async () => {
  const t = setup(LOAD)
  const p = fakePosting()
  await t.fake.repo.cancelAndBlock({ conversationId: FAKE_IDS.conversation, text: 'x', line: 'y', brokerId: p.brokerId, brokerMc: p.mcNumber })
  // the other load's block left this thread booked
  t.fake.state.conversation.status = 'booked'
  const blocksBefore = t.fake.state.blocks.length
  const cancelledBefore = t.fake.state.cancelledLoads.length
  const res = await cancel(t)
  assert.equal(res.cancelled, true)
  assert.equal(t.fake.state.blocks.length, blocksBefore)
  assert.equal(t.fake.state.messages.at(-2).content, CANCEL_BOOKING_TEXT)
  assert.equal(t.fake.state.conversation.status, 'open')
  assert.equal(t.fake.state.cancelledLoads.length, cancelledBefore + 1)
})

// Kills: the bypass leaking into ordinary chat (a typed message on a blocked broker must still be refused)
test('ordinary chat on a blocked broker is still refused', async () => {
  const t = setup(LOAD)
  const p = fakePosting()
  await t.fake.repo.cancelAndBlock({ conversationId: FAKE_IDS.conversation, text: 'x', line: 'y', brokerId: p.brokerId, brokerMc: p.mcNumber })
  t.fake.state.conversation.status = 'booked'
  await assert.rejects(sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: 'eta 2 hrs' }, { deps: t.deps }), { code: 'BROKER_BLOCKED' })
})

// Kills: a cancel the broker answered without blocking (released to another truck, RECLAIM_LINE) reported as cancelled
test('a reply that is not a block throws BOOKING_NOT_CANCELLED', async () => {
  const t = setup(LOAD)
  t.fake.state.messages.push({ id: 'r1', role: 'broker', content: RECLAIM_LINE, kind: 'text', deliverAt: new Date().toISOString() })
  await assert.rejects(cancel(t), { code: 'BOOKING_NOT_CANCELLED' })
  assert.equal(t.fake.state.blocks.length, 0)
})

// Kills: alreadyBlocked still inserting a broker_blocks row (or skipping the load cancel)
test('cancelAndBlock with alreadyBlocked writes no block row but still withdraws and writes the exchange', async () => {
  const { cancelAndBlock } = await import('../src/modules/brokerChat/brokerChat.repository.js')
  const statements = []
  const client = { query: async (sql) => { statements.push(sql); return { rows: [{ id: 'x' }], rowCount: 1 } } }
  const run = (fn) => fn(client)
  await cancelAndBlock({ conversationId: 'c1', text: 'cancel', line: 'no', alreadyBlocked: true }, { run })
  assert.equal(statements.filter((s) => /INSERT INTO broker_blocks/.test(s)).length, 0)
  assert.equal(statements.filter((s) => /INSERT INTO broker_messages/.test(s)).length, 2)
  assert.ok(statements.some((s) => /UPDATE broker_conversations/.test(s)))
  statements.length = 0
  await cancelAndBlock({ conversationId: 'c1', text: 'cancel', line: 'no' }, { run })
  assert.equal(statements.filter((s) => /INSERT INTO broker_blocks/.test(s)).length, 1)
})

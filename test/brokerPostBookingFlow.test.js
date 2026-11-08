// A booked thread through the real service with an in-memory repo: it stays
// open, never calls the model, never touches the agreed rate.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sendMessage, getThread, openLoadConversation } from '../src/modules/brokerChat/brokerChat.service.js'
import { openLoadConversation as repoOpenLoadConversation, bookedLoadFacts } from '../src/modules/brokerChat/brokerChat.repository.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const ids = { conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user }
const LOAD = {
  id: '600010', status: 'ontime', dispatchedAt: '2026-11-08T10:00:00Z', deliveredAt: null,
  rateUsd: 3100, accessorials: [], invoiceDueAt: null, invoicePaidAt: null, daysToPay: 30, openEvent: null,
}

function setup(load) {
  const fake = makeFakeBrokerRepo({ posting: fakePosting({ status: 'booked' }), lines: ['hello'] })
  fake.forceAgreed(3100)
  fake.state.conversation.status = 'booked'
  fake.state.load = load
  const counts = { model: 0, budget: 0, road: [] }
  const deps = {
    repo: fake.repo,
    getCarrier: async () => ({}),
    chatText: async () => { counts.model += 1; throw new Error('model must not be called') },
    assertCanSend: async () => { counts.budget += 1; throw new Error('budget must not be touched') },
    reportRoadEvent: async (args) => { counts.road.push(args) },
  }
  return { fake, deps, counts }
}
const send = (t, text) => sendMessage({ ...ids, text }, { deps: t.deps })

// Kills: booked thread hitting assertPostingOpen/beginChatTurn (POSTING_TAKEN) or the model
test('a booked load answers "eta 2 hrs" without POSTING_TAKEN, a model call or the budget', async () => {
  const t = setup({ ...LOAD, status: 'neutral', dispatchedAt: null })
  const res = await send(t, 'eta 2 hrs')
  assert.equal(res.action, 'ack')
  assert.equal(res.awaitingReply, false)
  assert.equal(t.counts.model + t.counts.budget, 0)
  assert.equal(t.fake.state.messages.at(-2).content, 'eta 2 hrs')
})

// Kills: the accident never reaching the road-event raiser, or raising it twice / blocking the carrier
test('an accident on the road raises one accident event and blocks nobody', async () => {
  const t = setup(LOAD)
  const res = await send(t, 'driver had an accident, we cant deliver')
  assert.equal(res.action, 'trouble')
  assert.equal(res.loadStage, 'in_transit')
  assert.equal(t.counts.road.length, 1)
  assert.equal(t.counts.road[0].eventType, 'accident')
  assert.equal(t.counts.road[0].loadId, LOAD.id)
  assert.equal(t.fake.state.blocks.length, 0)
  assert.equal(t.fake.state.conversation.status, 'booked')
})

// Kills: raising a second event when one is already open, and not naming the place
test('with an event already open nothing is raised and the broker names the place', async () => {
  const t = setup({ ...LOAD, openEvent: { eventType: 'breakdown', place: 'Amarillo, TX' } })
  await send(t, 'driver had an accident')
  assert.equal(t.counts.road.length, 0)
  assert.match(t.fake.state.messages.at(-1).content, /Amarillo, TX/)
})

// Kills: abandoning after the trouble reply not blocking, or blocking with the wrong reason
test('abandoning after the trouble reply blocks with the in-transit reason', async () => {
  const t = setup(LOAD)
  await send(t, 'truck broke down')
  const res = await send(t, 'cancel it, find someone else')
  assert.equal(res.blocked, true)
  assert.equal(t.fake.state.blocks.length, 1)
  assert.equal(t.fake.state.blocks[0].reason, 'carrier_abandoned_in_transit')
})

// Kills: a payment question on a delivered load withdrawing the agreement, blocking, or cancelling the load
test('a payment question after delivery leaves the booking, the broker and the load alone', async () => {
  const t = setup({ ...LOAD, status: 'done', deliveredAt: '2026-11-08T16:00:00Z', invoiceDueAt: '2026-12-08T16:00:00Z' })
  const res = await send(t, 'when do i get paid')
  assert.equal(res.action, 'payment')
  assert.equal(t.fake.state.conversation.status, 'booked')
  assert.equal(t.fake.state.blocks.length, 0)
  assert.equal(t.fake.state.cancelledLoads.length, 0)
  assert.equal(t.fake.state.conversation.rateConRateUsd, 3100)
})

// Kills: rate talk after booking changing the signed rate
test('a rate request after booking does not move the agreed rate', async () => {
  const t = setup(LOAD)
  const res = await send(t, 'can u do 3500 instead')
  assert.equal(res.action, 'rate_locked')
  assert.equal(t.fake.state.conversation.agreedRateUsd, 3100)
  assert.equal(t.fake.state.conversation.rateConRateUsd, 3100)
})

// Kills: getThread dropping the load stage the panel words its bar from
test('getThread on a booked thread carries the load stage and id', async () => {
  const t = setup(LOAD)
  const thread = await getThread(ids, { deps: t.deps })
  assert.equal(thread.loadStage, 'in_transit')
  assert.equal(thread.loadId, LOAD.id)
})

// Kills: openLoadConversation answering for a load the user did not book
test('openLoadConversation: no thread for a load the user did not book', async () => {
  const t = setup(LOAD)
  const opened = await openLoadConversation({ loadId: LOAD.id, userId: FAKE_IDS.user }, { deps: t.deps })
  assert.equal(opened.conversation.id, FAKE_IDS.conversation)
  await assert.rejects(
    openLoadConversation({ loadId: LOAD.id, userId: 'someone-else' }, { deps: t.deps }),
    { code: 'LOAD_HAS_NO_BROKER_THREAD' },
  )
})

// Kills: the thread-for-a-load insert not making a booked thread, or not scoped to the booker
test('openLoadConversation SQL inserts a booked thread with the signed rate, scoped to the booker', async () => {
  const sqls = []
  const db = await import('../src/db/pool.js')
  const original = db.pool.query
  db.pool.query = async (sql, params) => { sqls.push({ sql, params }); return { rows: [], rowCount: 0 } }
  try {
    assert.equal(await repoOpenLoadConversation('600010', 'u1'), null)
    await bookedLoadFacts('c1', 'u1')
  } finally {
    db.pool.query = original
  }
  const insert = sqls[0].sql
  assert.match(insert, /'booked'/)
  assert.match(insert, /rate_con_rate_usd/)
  assert.match(insert, /booked_by_user_id = \$2/)
  assert.deepEqual(sqls[0].params, ['600010', 'u1'])
  assert.doesNotMatch(sqls[1].sql, /credit_rating/)
  assert.match(sqls[1].sql, /booked_by_user_id = c\.user_id/)
})

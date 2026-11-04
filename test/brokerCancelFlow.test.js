// The cancellation policy through the real service with an in-memory repo:
// the model must never be called for these turns, and a block must leave the
// thread readable.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sendMessage, getThread } from '../src/modules/brokerChat/brokerChat.service.js'
import { WAIT_ETA_LINE } from '../src/modules/brokerChat/blockPolicy.js'
import { cancelAndBlock, releaseForNoEta } from '../src/modules/brokerChat/brokerChat.repository.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const ids = { conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user }

function setup({ status = 'agreed' } = {}) {
  const fake = makeFakeBrokerRepo({ posting: fakePosting(), lines: ['hello'] })
  let modelCalls = 0
  if (status !== 'open') fake.forceAgreed(3100)
  fake.state.conversation.status = status
  const deps = {
    repo: fake.repo,
    getCarrier: async () => ({}),
    chatText: async () => { modelCalls += 1; throw new Error('model must not be called') },
    assertCanSend: async () => { modelCalls += 1; throw new Error('budget must not be touched') },
  }
  return { fake, deps, calls: () => modelCalls }
}

const send = (t, text) => sendMessage({ ...ids, text }, { deps: t.deps })

// Kills: live T6 #239/#240 "Can you wait for me?" -- the wait path only ran on booked
test('agreed + "Can you wait for me?" asks for the ETA, then takes the load back on no ETA', async () => {
  const t = setup()
  const first = await send(t, 'Can you wait for me?')
  assert.equal(first.waitingForEta, true)
  assert.equal(t.fake.state.messages.at(-1).content, WAIT_ETA_LINE)
  assert.equal(t.fake.state.conversation.status, 'agreed')

  const second = await send(t, 'no eta yet')
  assert.equal(second.recovered, true)
  assert.equal(second.blocked, false)
  assert.match(t.fake.state.messages.at(-1).content, /another truck/i)
  assert.equal(t.fake.state.conversation.status, 'open')
  assert.equal(t.fake.state.blocks.length, 0)
  const paper = t.fake.state.messages.filter((m) => m.kind === 'rate_con')
  assert.ok(paper.length > 0 && paper.every((m) => m.voidedAt), 'paper is voided, not deleted')
  assert.equal(t.calls(), 0)
})

// Kills: live T7 Northgate false block "I cant cover that rate, can u do 3400?"
test('a rate counter on an agreed load does not block', async () => {
  const t = setup()
  await assert.rejects(send(t, 'I cant cover that rate, can u do 3400?'), /model must not be called|budget/)
  assert.equal(t.fake.state.blocks.length, 0)
  assert.equal(t.fake.state.conversation.status, 'agreed')
})

// Kills: live T5 GET -> 409 BROKER_BLOCKED right after the block
test('after a block the thread still loads, and sending is refused', async () => {
  const t = setup()
  const res = await send(t, 'sorry my truck broke down, cancel it, find another truck')
  assert.equal(res.blocked, true)

  const thread = await getThread(ids, { deps: t.deps })
  assert.equal(thread.blocked, true)
  assert.ok(thread.messages.some((m) => m.role === 'broker' && /Don't call this desk again/.test(m.content)))

  await assert.rejects(send(t, 'hello?'), { code: 'BROKER_BLOCKED' })
})

// Kills: getThread always answering blocked: true (T5 panel locked on a clean thread)
test('an unblocked thread reports blocked: false', async () => {
  const t = setup()
  assert.equal((await getThread(ids, { deps: t.deps })).blocked, false)
})

// Kills: dispatcher and broker rows written with the same created_at (broker line sorted first)
test('cancelAndBlock stamps both rows with clock_timestamp(), dispatcher first', async () => {
  const statements = []
  const client = {
    query: async (sql) => {
      statements.push(sql)
      return { rows: [{ id: 'x' }], rowCount: 1 }
    },
  }
  await cancelAndBlock({ conversationId: 'c1', text: 'cancel it', line: 'no' }, { run: (fn) => fn(client) })
  const inserts = statements.filter((s) => /INSERT INTO broker_messages/.test(s))
  assert.equal(inserts.length, 2)
  assert.match(inserts[0], /'dispatcher'/)
  assert.match(inserts[1], /'broker'/)
  for (const sql of inserts) {
    assert.match(sql, /created_at, deliver_at\)[\s\S]*clock_timestamp\(\), clock_timestamp\(\)/)
  }
})

// Kills: live T6 second "can u wait" after the ETA question answered with another wait
test('a second "can u wait" after the ETA question takes the load back', async () => {
  const t = setup()
  assert.equal((await send(t, 'can u wait')).waitingForEta, true)
  assert.equal((await send(t, 'can u wait')).recovered, true)
  assert.equal(t.fake.state.blocks.length, 0)
})

// Kills: no-ETA release writing a block, or deleting instead of voiding the paper
test('releaseForNoEta voids the paper with the wait reason and writes no block', async () => {
  const calls = []
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'x' }], rowCount: 1 } } }
  await releaseForNoEta({ conversationId: 'c1', text: 'no eta', line: 'x' }, { run: (fn) => fn(client) })
  assert.ok(calls.some((c) => /SET voided_at = now\(\), void_reason = \$2/.test(c.sql) && c.params[1] === 'wait_no_eta'))
  assert.ok(!calls.some((c) => /broker_blocks|DELETE/.test(c.sql)))
})

// Kills: the service not handing the ordered thread to the policy (ETA given, then "can u wait" reclaimed)
test('through the service, an ETA given after the question keeps the wait open', async () => {
  const t = setup()
  assert.equal((await send(t, 'can u wait')).waitingForEta, true)
  t.fake.state.messages.push({ id: 'eta1', role: 'dispatcher', content: 'eta 3 hrs', kind: 'text' })
  const again = await send(t, 'can u wait')
  assert.equal(again.waitingForEta, true)
  assert.equal(again.recovered, undefined)
  assert.equal(t.fake.state.conversation.status, 'agreed')
})

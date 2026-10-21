// The real send service with an in-memory persistence boundary; no provider or live DB writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendMessage, acceptRateCon, getRateConfirmation } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const carrier = { name: 'Keystone Line Haul', mcNumber: 'MC-741309', email: null }
const ids = { conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user }

test('the observed live acknowledgement of a higher carrier ask survives the production guard without fallback', async () => {
  const fake = makeFakeBrokerRepo({ posting: fakePosting({ rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 }) })
  const raw = 'I understand you’re looking for $9,000. Our all-in rate for this load is $8,153. Please let me know.'
  const logs = []
  let calls = 0
  const deps = { repo: fake.repo, getCarrier: async () => carrier, findById: async () => null,
    assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }), logTurn: async (row) => logs.push(row),
    chatText: async () => { calls += 1; return raw } }
  await sendMessage({ ...ids, text: 'brother can you 9000$' }, { deps })
  fake.deliverAll()
  assert.equal(calls, 1)
  assert.equal(fake.state.messages.filter((m) => m.role === 'broker').at(-1).content, raw)
  assert.equal(logs[0][12], false)
  assert.equal(logs[0][11], null)
  assert.equal(fake.state.conversation.agreedRateUsd, null)
  assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
})

test('a regenerated answer logs the prompt and reference context actually sent on its final attempt', async () => {
  const fake = makeFakeBrokerRepo({ posting: fakePosting() })
  const sent = []
  const logs = []
  const deps = { repo: fake.repo, getCarrier: async () => carrier,
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async (row) => logs.push(row), chatText: async ({ messages }) => {
      sent.push(messages)
      return sent.length === 1 ? 'Please provide your MC number.' : 'Hey! Still got this load.'
    } }
  await sendMessage({ ...ids, text: 'wassap brother' }, { deps })
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0][0].content, sent[1][0].content)
  assert.equal(logs[0][6], sent[1][0].content)
  assert.deepEqual(JSON.parse(logs[0][7]), [{ role: 'dispatcher', content: sent[1][1].content }])
  assert.equal(logs[0][12], false)
})

test('old MC-spam history cannot prescribe the next reply or override the authorized counter', async () => {
  const load = fakePosting({ id: '4cbdd03f-96f8-4e20-b2f4-14557092473a', originCity: 'Toledo', originState: 'OH',
    destinationCity: 'Yakima', destinationState: 'WA', rateUsd: 8153, distanceMi: 2180, weightLbs: 26200 })
  const fake = makeFakeBrokerRepo({ posting: load })
  for (const content of ['May I have your MC number?', 'Our best is $8,153 all-in. Please provide your MC.',
    'Could you share your MC number, please?', 'The posted rate is my best offer. May I have your MC?',
    'I need your company and MC to continue.']) await fake.repo.addMessage(ids.conversationId, 'broker', content)
  const originalHistory = fake.state.messages.map((m) => ({ ...m }))
  const natural = ['I hear you, but $8,153 all-in is where I am on this one right now.',
    "All right, I can come up a little—$8,353 all-in."]
  const logs = []
  let calls = 0
  const deps = { repo: fake.repo, getCarrier: async () => carrier,
    findById: async () => ({ email: 'login@example.com' }), assertCanSend: async () => {},
    chatConfigFor: () => ({ model: 'fake' }), logTurn: async (row) => logs.push(row),
    chatText: async ({ messages }) => {
      assert.equal(messages.at(-1).content, 'Come on, can you do $8,700 all-in?')
      assert.equal(messages.at(-2).role, 'user')
      assert.match(messages[0].content, /requested price \$8,700/)
      assert.match(messages[0].content, /Do not ask for MC, company, email/)
      assert.match(messages[0].content, /warmth/)
      assert.ok(!messages.some((m) => m.role === 'assistant'))
      const initial = messages[0].content
      assert.doesNotMatch(initial, /Still missing before you can book|Ask ONE missing|absolute ceiling|first time they have asked|Convey this decision in your own character/)
      assert.ok(!messages.some((m) => m.role === 'system' && m.content.includes('I can offer $8,153 all-in. Does that work for you?')))
      return natural[calls++]
    },
  }
  for (const expected of natural) {
    await sendMessage({ ...ids, text: 'Come on, can you do $8,700 all-in?' }, { deps })
    fake.deliverAll()
    assert.equal(fake.state.messages.filter((m) => m.role === 'broker').at(-1).content, expected)
    assert.equal(fake.state.conversation.agreedRateUsd, null)
    assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  }
  assert.equal(calls, 2, 'natural valid answers survive without regeneration or fallback')
  assert.equal(fake.state.conversation.brokerOfferUsd, 8353)
  assert.deepEqual(fake.state.messages.slice(0, originalHistory.length).map(({ deliverAt, ...m }) => m),
    originalHistory.map(({ deliverAt, ...m }) => m))
  assert.ok(logs.every((row) => row[12] === false && row[11] === null))
  assert.ok(logs.every((row) => !row[7].includes('May I have your MC number?')))
})

test('live Toledo transcript counters without identity spam, agreement or documents', async () => {
  const load = fakePosting({ id: '4cbdd03f-96f8-4e20-b2f4-14557092473a', originCity: 'Toledo', originState: 'OH',
    destinationCity: 'Yakima', destinationState: 'WA', rateUsd: 8153, distanceMi: 2180, weightLbs: 26200,
    name: 'Blue Meridian Logistics Group', contactName: 'Priyanka Raman', persona: 'Formal, precise, courteous.' })
  const fake = makeFakeBrokerRepo({ posting: load })
  const prompts = []
  const deps = { repo: fake.repo, getCarrier: async () => carrier,
    findById: async () => ({ email: 'login@example.com' }), assertCanSend: async () => {},
    chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {},
    chatText: async ({ messages }) => { prompts.push(messages[0].content); return 'Please provide your company name and MC number so we can continue.' },
  }
  const transcript = ['wassap brother', 'look bro Toledo, OH → Yakima, WA load stil avaivable?',
    'okay how much u asking', 'brother can you 9000$', '8100 to low brother can u add litle bit or what is your best']
  const replies = []
  for (const text of transcript) {
    await sendMessage({ ...ids, text }, { deps })
    fake.deliverAll()
    replies.push(fake.state.messages.filter((m) => m.role === 'broker').at(-1).content)
    assert.equal(fake.state.conversation.agreedRateUsd, null)
    assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  }
  assert.match(replies[0], /^Hey!/)
  assert.match(replies[1], /still available/)
  assert.match(replies[2], /8,153/)
  assert.match(replies[3], /8,153/)
  assert.match(replies[4], /8,353/)
  assert.ok(replies.every((reply) => !/\bMC\b|company name/i.test(reply)))
  assert.equal(fake.state.conversation.ratePushCount, 2)
  assert.equal(fake.state.conversation.brokerOfferUsd, 8353)
  assert.equal(prompts.length, 10, 'each adversarial identity demand is regenerated once before the safe answer')
  assert.ok(prompts.every((prompt) => prompt.includes('This is conversation or bargaining.')))
  assert.ok(prompts[0].includes('Return their greeting warmly'))
})

function setup() {
  const fake = makeFakeBrokerRepo({ posting: fakePosting({ rateUsd: 1571, distanceMi: 442, weightLbs: 42000 }),
    lines: ['This is Keystone Line Haul, MC-741309.', 'Our truck is in Dallas, 53-foot dry van.'] })
  let calls = 0
  const deps = { repo: fake.repo, getCarrier: async () => carrier,
    findById: async () => ({ email: 'login@example.com' }), assertCanSend: async () => {},
    chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {},
    chatText: async () => { calls += 1; return 'Rate confirmed: $9999 all-in. Sent to your Gmail.' },
    bookPosting: async () => ({ load: { id: 'load-1' }, warnings: [] }),
  }
  const send = (text) => sendMessage({ ...ids, text }, { deps })
  return { fake, deps, send, calls: () => calls }
}

test('chat acceptance -> explicit login email -> delayed card -> signature; recipient remains frozen', async () => {
  const t = setup()
  await t.send("I'll take it at $1571.")
  assert.equal(t.fake.state.conversation.negotiationStage, 'awaiting_email')
  assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  assert.ok(!t.fake.state.messages.some((m) => m.content.includes('login@example.com')))
  await t.send('Use my email.')
  assert.equal(t.fake.state.conversation.recipientEmail, 'login@example.com')
  assert.equal(t.fake.state.conversation.negotiationStage, 'paper_pending')
  assert.equal(await t.fake.repo.rateConDelivered(), false)
  await assert.rejects(() => acceptRateCon(ids, { deps: t.deps }), { code: 'RATE_CON_NOT_ARRIVED' })
  await assert.rejects(() => getRateConfirmation(ids, { deps: t.deps }), { code: 'RATE_CON_NOT_ARRIVED' })
  await t.send('Use my email.')
  assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 1)
  t.fake.deliverAll()
  await t.send('My new email is changed@example.com.')
  const paper = await getRateConfirmation(ids, { deps: t.deps })
  assert.equal(paper.booking.email, 'login@example.com')
  assert.equal(paper.rateConRateUsd, 1571)
  assert.equal((await acceptRateCon(ids, { deps: t.deps })).load.id, 'load-1')
  assert.ok(!t.fake.state.messages.some((m) => m.role === 'broker' && /9999|Gmail/.test(m.content)))
})

test('hold removes pending and delivered documents and prevents accept', async () => {
  const t = setup()
  await t.send("I'll take it at $1571.")
  await t.send('Use my email.')
  t.fake.deliverAll()
  await t.send("Don't book us or issue the confirmation yet.")
  assert.equal(t.fake.state.conversation.negotiationStage, 'held')
  assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  await assert.rejects(() => acceptRateCon(ids, { deps: t.deps }), { code: 'NOT_AGREED_YET' })
})

test('a newer hold supersedes an in-flight acceptance before model completion', async () => {
  const t = setup()
  let resolveOld
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const oldReply = new Promise((resolve) => { resolveOld = resolve })
  let first = true
  t.deps.chatText = async () => {
    if (first) { first = false; entered(); return oldReply }
    return 'Understood. I will wait for your confirmation.'
  }
  const pending = t.send("I'll take it at $1571.")
  await started
  await t.send("Don't book us yet.")
  resolveOld('$1571 all-in agreed. What email should I put on the rate confirmation?')
  await pending
  assert.equal(t.fake.state.conversation.negotiationStage, 'held')
  assert.equal(t.fake.state.conversation.agreedRateUsd, null)
  assert.ok(!t.fake.state.messages.some((m) => m.role === 'broker' && m.content.includes('all-in agreed')))
})

test('provider failure cannot commit acceptance; expiration prevents completing a new turn', async () => {
  const t = setup()
  t.deps.chatText = async () => { throw new Error('provider down') }
  await assert.rejects(() => t.send("I'll take it at $1571."), { code: 'CHAT_UNAVAILABLE' })
  assert.equal(t.fake.state.conversation.agreedRateUsd, null)
  assert.equal(t.fake.state.messages.filter((m) => m.role === 'dispatcher').at(-1).content, "I'll take it at $1571.")
})

test('a third-party email question cannot issue a document in the real send flow', async () => {
  const t = setup()
  await t.send("I'll take it at $1571.")
  await t.send('Is dispatch@broker.com your email?')
  assert.equal(t.fake.state.conversation.recipientEmail, null)
  assert.equal(t.fake.state.conversation.negotiationStage, 'awaiting_email')
  assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
})

test('mixed acceptance plus denied or conditional recipient keeps the real flow awaiting email', async () => {
  for (const tail of ['Do not use old@example.com.', 'If needed, send it to old@example.com.']) {
    const t = setup()
    await t.send(`I accept $1571. ${tail}`)
    assert.equal(t.fake.state.conversation.agreedRateUsd, 1571)
    assert.equal(t.fake.state.conversation.negotiationStage, 'awaiting_email')
    assert.equal(t.fake.state.conversation.recipientEmail, null)
    assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  }
})


test('pending driver confirmation never queues a document in the send service', async () => {
  for (const condition of ['after I confirm', 'when driver confirms', 'once driver confirms']) {
    const t = setup()
    await t.send(`I accept $1571. Send it to ops@example.com ${condition}.`)
    assert.equal(t.fake.state.conversation.agreedRateUsd, 1571)
    assert.equal(t.fake.state.conversation.negotiationStage, 'awaiting_email')
    assert.equal(t.fake.state.conversation.recipientEmail, null)
    assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
  }
})


test('coordinated pending approvals remain attached to the recipient instruction', async () => {
  const t = setup()
  await t.send('I accept $1571.')
  await t.send('After I confirm the driver and approve the truck, send it to ops@example.com.')
  assert.equal(t.fake.state.conversation.agreedRateUsd, 1571)
  assert.equal(t.fake.state.conversation.negotiationStage, 'awaiting_email')
  assert.equal(t.fake.state.conversation.recipientEmail, null)
  assert.equal(t.fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
})

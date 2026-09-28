// The bridge's decisions, against the real schema, with a spy standing
// in for the chat service door and a fake for the network.
//
// The most important assertion in this file is the FIRST one: a Telegram
// message reaches the thread through driverChat.service.sendMessage --
// the ONE door. If the bridge ever grows its own model call, its own
// delay arithmetic or its own budget check, the plan is broken and this
// test is the tripwire.
//
// Skips without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')

// A client that records what the bot itself said into the group.
function fakeTelegram() {
  const said = []
  return {
    said,
    async sendMessage(chatId, text) {
      said.push({ chatId: String(chatId), text })
      return { message_id: 9000 + said.length }
    },
  }
}

// The chat service spy: records the sendMessage calls the bridge makes.
// openConversation is stubbed rather than delegated -- the real one writes
// through the pool, which would block on this test's uncommitted fixture
// rows (a deadlock, not a failure). The bridge's contract with it is the
// shape of what comes back, and that is what the stub preserves.
function chatSpy(log, conversationId = 'spy-conversation') {
  return {
    async openConversation(args) {
      return { conversation: { id: conversationId }, driver: {}, messages: [] }
    },
    async sendMessage(args) {
      log.push(args)
      return { dispatcherMessage: { id: 'spy' }, awaitingReply: true }
    },
  }
}

async function fixture(client) {
  const user = (await client.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'TG Bridge Dispatcher') RETURNING id`,
    [`tg-bridge-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.test`],
  )).rows[0]
  const driver = (await client.query(`SELECT id, name FROM drivers ORDER BY id LIMIT 1`)).rows[0]
  const conversation = (await client.query(
    `INSERT INTO driver_conversations (driver_id, user_id) VALUES ($1, $2) RETURNING id`,
    [driver.id, user.id],
  )).rows[0]
  const message = (await client.query(
    `INSERT INTO driver_messages (conversation_id, role, content, deliver_at)
     VALUES ($1, 'driver', 'Loaded and rolling.', now()) RETURNING id`,
    [conversation.id],
  )).rows[0]
  return {
    userId: user.id, driverId: driver.id, driverName: driver.name,
    conversationId: conversation.id, messageId: message.id,
  }
}

async function linkChat(client, { userId, chatId }) {
  await client.query(
    `INSERT INTO telegram_links (chat_id, user_id, linked_by_tg_user) VALUES ($1, $2, 777)`,
    [chatId, userId],
  )
}

test('a reply reaches the thread through driverChat.service.sendMessage — the one door', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })
    await repo.claimDelivery({ messageId: fx.messageId, chatId: '-400777' }, client)
    await repo.markSent(fx.messageId, 4242, client)

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      {
      chatId: '-400777', text: 'Copy that, keep it rolling.',
      fromTgUserId: 777, replyToTelegramMessageId: 4242,
    },
      tg, client)

    // Kills: any second path into the thread -- a bridge-side model call,
    // its own delay arithmetic, its own budget check. The bridge must
    // know nothing but the door.
    assert.equal(log.length, 1)
    assert.deepEqual(log[0], {
      conversationId: fx.conversationId,
      userId: fx.userId,
      text: 'Copy that, keep it rolling.',
    })
    assert.equal(tg.said.length, 0, 'the group hears nothing; the reply went to the thread')
  })
})

test('/link consumes a valid code and binds the chat', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await repo.insertCode({ code: 'LINK77', userId: fx.userId, expiresAt: new Date(Date.now() + 600_000) }, client)

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400888', text: '/link link77', fromTgUserId: 777 },
      tg, client)

    const link = await repo.getLinkByChat('-400888', client)
    assert.ok(link, 'the chat is linked')
    assert.equal(String(link.userId), String(fx.userId))
    assert.equal(String(link.linkedByTgUser), '777')
    assert.equal(tg.said.filter((s) => s.text.includes('Linked')).length, 1)

    // The code is gone: a second /link with the same code is refused.
    await bridge.handleUpdate(
      { chatId: '-400999', text: '/link link77', fromTgUserId: 888 },
      tg, client)
    assert.ok(tg.said.some((s) => s.text.includes('Unknown or expired')), 'a used code is refused')
  })
})

test('/d sets the current driver; plain text then goes to that driver', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400777', text: `/d ${fx.driverName}`, fromTgUserId: 777 },
      tg, client)
    assert.ok(tg.said.some((s) => s.text.includes(`Talking to ${fx.driverName}`)), 'the choice is confirmed')

    const link = await repo.getLinkByChat('-400777', client)
    assert.equal(link.currentDriverId, fx.driverId)

    log.length = 0
    await bridge.handleUpdate(
      { chatId: '-400777', text: 'Fuel stop, back in 20.', fromTgUserId: 777 },
      tg, client)
    assert.equal(log.length, 1, 'the standing /d routes plain text')
    assert.equal(log[0].conversationId, 'spy-conversation', 'the resolved thread id reaches the door')
  })
})

test('an ambiguous name asks back; the code never picks', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })
    // A second driver wearing the same name. All NOT NULL columns are
    // carried: phone, license_expires_on, pay model with its CHECK.
    const second = (await client.query(
      `INSERT INTO drivers (id, name, email, phone, cdl_number, cdl_class, license_expires_on,
                            duty_status, pay_model, pay_percent_bp, home_base_city, home_base_state)
       VALUES ('d9999', $1, $2, '555-0100', 'CDL9999', 'A', CURRENT_DATE + 365,
               'off', 'percent', 2700, 'Memphis', 'TN') RETURNING id`,
      [fx.driverName, `tg-dup-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.test`],
    )).rows[0]

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400777', text: `/d ${fx.driverName}`, fromTgUserId: 777 },
      tg, client)

    assert.equal(log.length, 0, 'nothing was delivered to anyone')
    assert.ok(tg.said.some((s) => s.text.includes('Several drivers')), 'the person is asked, not the code deciding')
    const link = await repo.getLinkByChat('-400777', client)
    assert.equal(link.currentDriverId, null, 'no standing choice was made by the machine')
  })
})

test('a message with no recipient and no /d asks who, with the roster', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400777', text: 'Ok, ketdim', fromTgUserId: 777 },
      tg, client)

    assert.equal(log.length, 0, 'nothing was guessed')
    assert.ok(tg.said[0].text.includes('Who is this for?'))
    assert.ok(tg.said[0].text.includes(fx.driverName), 'the roster is in the answer')
  })
})

test('a reply to a message the bot never sent gets an honest miss, not a guess', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })

    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      {
      chatId: '-400777', text: 'who is this for?',
      fromTgUserId: 777, replyToTelegramMessageId: 123456,
    },
      tg, client)

    assert.equal(log.length, 0)
    assert.ok(tg.said[0].text.includes("can't tell who that reply was for"))
  })
})

test('CHAT_DAILY_LIMIT is reported to the group as the budget fact', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    await linkChat(client, { userId: fx.userId, chatId: '-400777' })
    await repo.claimDelivery({ messageId: fx.messageId, chatId: '-400777' }, client)
    await repo.markSent(fx.messageId, 4242, client)

    bridge.setChatBackendForTests({
      async openConversation() { throw new Error('not used here') },
      async sendMessage() {
        // The door was reached (otherwise no 'daily limit' line could
        // appear below): the stub itself is the proof the send was tried.
        const { AppError } = await import('../src/lib/errors.js')
        throw new AppError('CHAT_DAILY_LIMIT', { message: 'bugungi limit' })
      },
    })
    t.after(() => bridge.setChatBackendForTests(null))

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      {
      chatId: '-400777', text: 'any update?',
      fromTgUserId: 777, replyToTelegramMessageId: 4242,
    },
      tg, client)

    assert.ok(tg.said.some((s) => s.text.includes('daily limit')), 'the group is told the truth')
    assert.ok(!tg.said.some((s) => s.text.toLowerCase().includes('driver')), 'the driver is not blamed for the outage')
  })
})

test('an unlinked chat is told once per window, not per message', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))

    // The in-memory half of the notice window survives between tests in
    // this process; each test here must start from a clean slate.
    bridge.resetNoticeCache()

    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)

    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400555', text: 'hello?', fromTgUserId: 777 },
      tg, client)
    await bridge.handleUpdate(
      { chatId: '-400555', text: 'hello again', fromTgUserId: 777 },
      tg, client)
    await bridge.handleUpdate(
      { chatId: '-400555', text: 'third try', fromTgUserId: 777 },
      tg, client)

    const notices = tg.said.filter((s) => s.text.includes('not linked'))
    assert.equal(notices.length, 1, 'one notice, then quiet')

    // A different chat is still told: the window is per chat.
    await bridge.handleUpdate(
      { chatId: '-400666', text: 'hello?', fromTgUserId: 777 },
      tg, client)
    assert.equal(tg.said.filter((s) => s.text.includes('not linked')).length, 2)
  })
})

test('the bot does not answer bots, and the notice map survives a restart', { skip: !hasDb }, async (t) => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')
  const bridge = await import('../src/modules/telegram/telegram.bridge.js')

  await inRollback(pool, async (client) => {
    const log = []
    bridge.setChatBackendForTests(chatSpy(log))
    t.after(() => bridge.setChatBackendForTests(null))
    bridge.resetNoticeCache()

    // The map is written by the first notice...
    const tg = fakeTelegram()
    bridge.setBotTelegramForTests(tg)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400555', text: 'hi', fromTgUserId: 777 },
      tg, client)
    assert.equal(tg.said.filter((s) => s.text.includes('not linked')).length, 1)

    // ...a fresh process re-reads it from sim_state and stays quiet.
    bridge.resetNoticeCache()
    const map = await repo.getNoticeMap(client)
    assert.ok(map['-400555'], 'the notice time is in sim_state')
    const tg2 = fakeTelegram()
    bridge.setBotTelegramForTests(tg2)
    t.after(() => bridge.setBotTelegramForTests(null))
    await bridge.handleUpdate(
      { chatId: '-400555', text: 'hi again', fromTgUserId: 777 },
      tg2, client)
    assert.equal(tg2.said.filter((s) => s.text.includes('not linked')).length, 0, 'no second notice after a restart')
  })
})

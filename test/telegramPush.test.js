// The outgoing push, without a single real request.
//
// Every test names the mutation it kills. The network side arrives as a
// fake client (the createTelegramClient seam), the database side runs
// inside a transaction that always rolls back -- so the suite is safe on
// a plane, and the outbox's guarantees are still checked against the
// real schema.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { pushOne, PER_TICK, TICK_SEC, RATE } from '../src/jobs/telegramPush.js'
import { formatDriverMessage } from '../src/modules/telegram/telegram.format.js'

const { hasDb } = await import('./helpers/db.js')

// A client that records what it was asked to send, and fails on demand.
// Nothing in it touches a socket.
function fakeTelegram({ fail = false } = {}) {
  const sent = []
  return {
    sent,
    async sendMessage(chatId, text) {
      if (fail) throw new Error('boom')
      sent.push({ chatId: String(chatId), text })
      return { message_id: 1000 + sent.length }
    },
  }
}

async function fixture(client) {
  const user = (await client.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'TG Push Dispatcher') RETURNING id`,
    [`tg-push-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.test`],
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
  return { userId: user.id, driverId: driver.id, driverName: driver.name, conversationId: conversation.id, messageId: message.id }
}

// Kills: someone "tuning" the numbers by hand. They are not choices --
// they are derived from the published group cap
// (https://core.telegram.org/bots/faq, checked 2026-09-28): 20/group/minute
// spread over the tick, and one second between consecutive sends.
test('the per-tick cap is derived from the group rate, not picked', () => {
  assert.equal(RATE.GROUP_MSG_PER_MIN, 20)
  assert.equal(RATE.MIN_GAP_MS, 1000)
  assert.equal(PER_TICK, Math.floor((TICK_SEC / 60) * RATE.GROUP_MSG_PER_MIN))
  assert.equal(PER_TICK, 5, 'a 15s tick carries at most five messages')
})

// Kills: prefixing without the separator, or rendering a missing truck
// as the literal string "undefined".
test('the outgoing line is the driver, their plate, then what they said', () => {
  assert.equal(
    formatDriverMessage({ driverName: 'Marcus Hale', truckId: 'TRK-104', content: 'Loaded and rolling.' }),
    'Marcus Hale · TRK-104\nLoaded and rolling.',
  )
  assert.equal(
    formatDriverMessage({ driverName: 'Marcus Hale', truckId: null, content: 'At the yard.' }),
    'Marcus Hale\nAt the yard.',
  )
})

test('a claimed-and-sent message records the telegram id exactly once', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const tg = fakeTelegram()

    const result = await pushOne(
      { messageId: fx.messageId, chatId: '-100555', driverName: fx.driverName, truckId: 'TRK-104', content: 'Loaded and rolling.' },
      client, tg,
    )
    assert.ok(result.sent, 'the send went out')

    const row = (await client.query(
      `SELECT sent_at, telegram_message_id, attempts, last_error FROM telegram_deliveries WHERE message_id = $1`,
      [fx.messageId],
    )).rows[0]
    assert.ok(row.sent_at, 'marked sent')
    assert.equal(String(row.telegram_message_id), '1001', 'the telegram id is kept for reply routing')
    assert.equal(row.attempts, 0)
    assert.equal(row.last_error, null)
    assert.equal(tg.sent[0].text, `${fx.driverName} · TRK-104\nLoaded and rolling.`)
  })
})

test('a message claimed by another tick is not sent again', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const tg = fakeTelegram()
    const payload = { messageId: fx.messageId, chatId: '-100555', driverName: fx.driverName, truckId: null, content: 'Loaded and rolling.' }

    assert.ok((await pushOne(payload, client, tg)).sent, 'the first tick sends')
    const second = await pushOne(payload, client, tg)
    assert.equal(second.skipped, 'claimed elsewhere', 'the second tick is told to back off')
    assert.equal(tg.sent.length, 1, 'the group saw the message once, not twice')
  })
})

test('a failed send counts the attempt and the message is not lost', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const tg = fakeTelegram({ fail: true })

    const result = await pushOne(
      { messageId: fx.messageId, chatId: '-100555', driverName: fx.driverName, truckId: null, content: 'Loaded and rolling.' },
      client, tg,
    )
    assert.ok(result.failed, 'the failure is reported upward, not swallowed')

    const row = (await client.query(
      `SELECT attempts, sent_at, last_error FROM telegram_deliveries WHERE message_id = $1`,
      [fx.messageId],
    )).rows[0]
    assert.equal(row.attempts, 1, 'the try is counted')
    assert.equal(row.sent_at, null, 'a failed send is never marked sent')
    assert.match(row.last_error, /boom/)

    // The words still exist: transport failure deletes nothing.
    const message = (await client.query(
      `SELECT content FROM driver_messages WHERE id = $1`,
      [fx.messageId],
    )).rows[0]
    assert.equal(message.content, 'Loaded and rolling.')
  })
})

test('past the attempt cap the job backs off entirely', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const tg = fakeTelegram()
    await repo.claimDelivery({ messageId: fx.messageId, chatId: -100555 }, client)
    for (let i = 1; i <= 5; i += 1) await repo.markFailed(fx.messageId, `boom ${i}`, client)

    const result = await pushOne(
      { messageId: fx.messageId, chatId: '-100555', driverName: fx.driverName, truckId: null, content: 'Loaded and rolling.' },
      client, tg,
    )
    assert.equal(result.skipped, 'claimed elsewhere', 'a capped row cannot be re-claimed')
    assert.equal(tg.sent.length, 0, 'nothing is sent for a row past its tries')

    const row = (await client.query(
      `SELECT attempts, sent_at FROM telegram_deliveries WHERE message_id = $1`,
      [fx.messageId],
    )).rows[0]
    assert.equal(row.attempts, 5)
    assert.equal(row.sent_at, null, 'the message stays unsent and visible as such in the app')
  })
})

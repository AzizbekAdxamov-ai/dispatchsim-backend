// The Telegram bridge's store, against the real schema, inside a
// transaction that always rolls back.
//
// The tests below name the mutation each kills. The ones about the
// outbox are the important ones: the claim's idempotency and the attempt
// cap are enforced by the DATABASE (046's PRIMARY KEY and CHECK), and a
// test that only checked application code would pass forever while the
// tables let two ticks send one message twice.
//
// Skips without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')

// A dispatcher to own the link, and a driver for the thread. Drivers carry
// CHECKs (id like 'd123', email format), so real-looking values are used;
// users need a password_hash (NOT NULL), any string satisfies it here
// because auth is never exercised in this file.
async function fixture(client) {
  // Migration 003 moved roles to user_roles; users carries no role column.
  // Auth is never exercised here, so the user row alone is enough.
  const user = (await client.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'TG Test Dispatcher') RETURNING id`,
    [`tg-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.test`],
  )).rows[0]
  const driver = (await client.query(
    `SELECT id FROM drivers ORDER BY id LIMIT 1`,
  )).rows[0]
  if (!driver) throw new Error('no drivers in this database')
  return { userId: user.id, driverId: driver.id }
}

async function threadFixture(client, { userId, driverId }) {
  const conversation = (await client.query(
    `INSERT INTO driver_conversations (driver_id, user_id) VALUES ($1, $2) RETURNING id`,
    [driverId, userId],
  )).rows[0]
  const message = (await client.query(
    `INSERT INTO driver_messages (conversation_id, role, content, deliver_at)
     VALUES ($1, 'driver', $2, now()) RETURNING id`,
    [conversation.id, 'Loaded and rolling.'],
  )).rows[0]
  return { conversationId: conversation.id, messageId: message.id }
}

test('the link code format is enforced by the CHECK, not by the app alone', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const { userId } = await fixture(client)
    await assert.rejects(
      () => client.query(
        `INSERT INTO telegram_link_codes (code, user_id, expires_at)
         VALUES ($1, $2, now() + interval '10 minutes')`,
        ['ab1!', userId], // wrong shape: lowercase and punctuation
      ),
      (err) => /telegram_link_codes_fmt/.test(err.message),
      'a code not shaped like /^[A-Z0-9]{6}$/ is refused by the table',
    )
  })
})

test('one user holds one chat: the second link is refused by UNIQUE (user_id)', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const { userId } = await fixture(client)
    await client.query(
      `INSERT INTO telegram_links (chat_id, user_id, linked_by_tg_user) VALUES (-1001, $1, 777)`,
      [userId],
    )
    await assert.rejects(
      () => client.query(
        `INSERT INTO telegram_links (chat_id, user_id, linked_by_tg_user) VALUES (-1002, $1, 777)`,
        [userId],
      ),
      (err) => /telegram_links_one_per_user/.test(err.message),
      'a second chat for the same dispatcher is a mistake the table refuses',
    )
  })
})

test('a code is one-time: the second consumption matches no row', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const { userId } = await fixture(client)
    await repo.insertCode({ code: 'ABC123', userId, expiresAt: new Date(Date.now() + 600_000) }, client)

    const first = await repo.markCodeUsed('ABC123', client)
    assert.equal(first.userId, userId, 'the first consumer wins')

    const second = await repo.markCodeUsed('ABC123', client)
    assert.equal(second, null, 'the second consumption of a used code is "no such code"')

    // Same for an expired one: issued, then left to lapse.
    await repo.insertCode({ code: 'EXPIRE', userId, expiresAt: new Date(Date.now() - 1000) }, client)
    const expired = await repo.markCodeUsed('EXPIRE', client)
    assert.equal(expired, null, 'an expired code is "no such code" too')
  })
})

test('the outbox claim is idempotent: the second claim returns no row', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const { messageId } = await threadFixture(client, fx)

    const first = await repo.claimDelivery({ messageId, chatId: -100999 }, client)
    assert.ok(first, 'the first claim wins')
    const second = await repo.claimDelivery({ messageId, chatId: -100999 }, client)
    assert.equal(second, null, 'the second claim of the same message is refused by the PRIMARY KEY')
  })
})

test('a send failure counts the attempt and keeps the message; five kills the retry', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const { messageId } = await threadFixture(client, fx)
    await repo.claimDelivery({ messageId, chatId: -100999 }, client)

    for (let i = 1; i <= 5; i += 1) {
      const marked = await repo.markFailed(messageId, `boom ${i}`, client)
      assert.ok(marked, `attempt ${i} is counted`)
      assert.equal(marked.attempts, i)
    }
    // The sixth is refused by the WHERE, not silently over the cap.
    const sixth = await repo.markFailed(messageId, 'boom 6', client)
    assert.equal(sixth, null, 'the cap is enforced by the UPDATE, not by a loop')

    // The message is still there, still claimed, still unsent.
    const row = (await client.query(
      `SELECT attempts, sent_at, last_error FROM telegram_deliveries WHERE message_id = $1`,
      [messageId],
    )).rows[0]
    assert.equal(row.attempts, 5)
    assert.equal(row.sent_at, null, 'a failed message is never marked sent')
    assert.match(row.last_error, /boom 5/)
  })
})

test('a sent message is marked sent once, and a failed mark cannot touch it', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const { messageId } = await threadFixture(client, fx)
    await repo.claimDelivery({ messageId, chatId: -100999 }, client)

    const sent = await repo.markSent(messageId, 424242, client)
    assert.ok(sent, 'the send is recorded')

    const again = await repo.markSent(messageId, 424243, client)
    assert.equal(again, null, 'a second send report cannot rewrite the first one')

    const failed = await repo.markFailed(messageId, 'late failure', client)
    assert.equal(failed, null, 'a sent message is never re-counted as failed')

    const row = (await client.query(
      `SELECT telegram_message_id FROM telegram_deliveries WHERE message_id = $1`,
      [messageId],
    )).rows[0]
    assert.equal(String(row.telegram_message_id), '424242', 'the first telegram id stands')
  })
})

test('the pending scan finds only delivered driver messages without a claim', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const { conversationId, messageId } = await threadFixture(client, fx)

    // The scan reaches a message only through its dispatcher's link --
    // no link, no Telegram destination, nothing scanned out.
    await client.query(
      `INSERT INTO telegram_links (chat_id, user_id, linked_by_tg_user) VALUES (-100999, $1, 777)`,
      [fx.userId],
    )
    // A second message the dispatcher sent -- never scanned out, the
    // bridge carries the DRIVER's voice only.
    await client.query(
      `INSERT INTO driver_messages (conversation_id, role, content, deliver_at)
       VALUES ($1, 'dispatcher', 'Copy that.', now())`,
      [conversationId],
    )
    // A third message still waiting on its delay -- not delivered yet.
    await client.query(
      `INSERT INTO driver_messages (conversation_id, role, content, deliver_at)
       VALUES ($1, 'driver', 'give me a minute', now() + interval '10 minutes')`,
      [conversationId],
    )

    const pending = await repo.pendingMessages(50, client)
    const mine = pending.filter((p) => p.messageId === messageId)
    assert.equal(mine.length, 1, 'exactly the delivered driver message is scanned out')
    // pg returns bigint as a string, so the comparison goes through String().
    assert.equal(String(mine[0].chatId), '-100999', 'the chat comes from the writer dispatcher\'s link')
    assert.equal(
      mine[0].driverName,
      (await client.query(`SELECT name FROM drivers WHERE id = $1`, [fx.driverId])).rows[0].name,
      'the outgoing line is prefixed with the driver\'s own name',
    )
  })
})

test('a reply resolves to the exact thread that produced the bot message', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const repo = await import('../src/modules/telegram/telegram.repository.js')

  await inRollback(pool, async (client) => {
    const fx = await fixture(client)
    const { conversationId, messageId } = await threadFixture(client, fx)
    await repo.claimDelivery({ messageId, chatId: -100999 }, client)
    await repo.markSent(messageId, 555001, client)

    const target = await repo.findReplyTarget({ chatId: '-100999', telegramMessageId: 555001 }, client)
    assert.ok(target, 'the reply target is found')
    assert.equal(target.conversationId, conversationId)
    assert.equal(target.driverId, fx.driverId)
    assert.equal(target.userId, fx.userId)

    const miss = await repo.findReplyTarget({ chatId: '-100999', telegramMessageId: 999999 }, client)
    assert.equal(miss, null, 'a reply to a message the bot never sent has no target')
  })
})

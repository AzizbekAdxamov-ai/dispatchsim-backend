// The vision switch: a photo either reaches the model or the bot says
// honestly that it cannot look. Pure tests for the decisions, one DB test
// for the attachment row's shape (047).
//
// The critical mutation these kill: handing a blind model an image and
// passing its reply off as having "seen" the photo. The switch defaults
// to off, and off means the caption travels and the bytes do not.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { photoDecision, incomingRecordText, BLIND_PHOTO_NOTICE } from '../src/bot/vision.js'
import { buildMessages } from '../src/modules/driverChat/driverChat.prompt.js'

const { hasDb } = await import('./helpers/db.js')

// (The two collectPhotos tests moved with the function, to
// ../../telegram_bot/test/parse.test.js: folding what Telegram sent is
// the bot process's work now. What stays here is the half that needs to
// know about the model.)

test('photoDecision: vision on hands the photo over', () => {
  assert.deepEqual(photoDecision({ enabled: true, photoCount: 1 }), { photo: true, textOnly: false })
})

test('photoDecision: vision off is blind and honest about it', () => {
  // Kills: `enabled || true` shortcuts, or forwarding the bytes anyway
  // and letting the model's reply read as if it had looked.
  const decision = photoDecision({ enabled: false, photoCount: 1 })
  assert.equal(decision.photo, false)
  assert.equal(decision.blind, true)
  assert.match(BLIND_PHOTO_NOTICE(), /cannot look at pictures/)
})

test('photoDecision: no photos is a plain text turn', () => {
  assert.deepEqual(photoDecision({ enabled: true, photoCount: 0 }), { photo: false, textOnly: true })
})

// (The two buildUserContent tests that were here are gone with the
// function. It built the content-parts shape a second time and nothing
// called it -- buildMessages, tested just below, builds it on the path
// that actually runs.)

test('buildMessages carries images as content parts; aiClient stays untouched', () => {
  // Kills: someone "fixing" vision by teaching aiClient about images --
  // the whole point is that the messages array IS the interface.
  const messages = buildMessages({
    systemPrompt: 'sys',
    history: [{ role: 'driver', content: 'earlier' }],
    newMessage: '[photo] load docs',
    images: ['data:image/jpeg;base64,AAAA'],
  })
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].content, 'earlier')
  assert.deepEqual(messages[2].content, [
    { type: 'text', text: '[photo] load docs' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
  ])

  // No images: the user turn is still a plain string, byte for byte the
  // shape every existing chat sends.
  const plain = buildMessages({ systemPrompt: 'sys', history: [], newMessage: 'hi' })
  assert.equal(plain[1].content, 'hi')
})

// Kills: collapsing the two cases into one line again. Both branches
// used to return the same string, so `blind` decided nothing and this
// test could not tell the cases apart -- it passed on a function with a
// parameter that did not work. The thread is the dispatcher's own
// record: when the model could not look at the picture, it says so.
test('the thread records whether the photo was actually seen', () => {
  assert.equal(incomingRecordText({ caption: 'BOL', blind: false }), '[photo] BOL')
  assert.equal(incomingRecordText({ caption: 'BOL', blind: true }), '[photo, not seen] BOL')
  assert.equal(incomingRecordText({ caption: null, blind: false }), '[photo] (photo)')
  assert.notEqual(
    incomingRecordText({ caption: 'BOL', blind: true }),
    incomingRecordText({ caption: 'BOL', blind: false }),
  )
})

test('an attachment row lands in 047\'s table and dies with its message', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const user = (await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'T') RETURNING id`,
      [`tg-vis-${Date.now()}@example.test`],
    )).rows[0]
    const driver = (await client.query(`SELECT id FROM drivers ORDER BY id LIMIT 1`)).rows[0]
    const conversation = (await client.query(
      `INSERT INTO driver_conversations (driver_id, user_id) VALUES ($1, $2) RETURNING id`,
      [driver.id, user.id],
    )).rows[0]
    const message = (await client.query(
      `INSERT INTO driver_messages (conversation_id, role, content, deliver_at)
       VALUES ($1, 'dispatcher', '[photo] BOL', now()) RETURNING id`,
      [conversation.id],
    )).rows[0]

    await client.query(
      `INSERT INTO telegram_attachments (message_id, file_id, mime, caption)
       VALUES ($1, $2, 'image/jpeg', $3)`,
      [message.id, 'AgACAg-file-ref', 'BOL from the shipper'],
    )
    const row = (await client.query(
      `SELECT file_id, mime, caption FROM telegram_attachments WHERE message_id = $1`,
      [message.id],
    )).rows[0]
    assert.equal(row.file_id, 'AgACAg-file-ref')
    assert.equal(row.mime, 'image/jpeg')
    assert.equal(row.caption, 'BOL from the shipper')
  })
})

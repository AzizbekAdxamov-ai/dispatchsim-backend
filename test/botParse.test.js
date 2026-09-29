// What the bot makes of what Telegram sends.
//
// Pure: no network, no database, no clock. Each test names the mutation
// it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toFacts, factsForBatch, batchUpdates, lastUpdateId } from '../src/bot/parse.js'

function message(over = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 777, is_bot: false },
      text: 'rolling',
      ...over,
    },
  }
}

function photoUpdate({ updateId, groupId, caption, fileId }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 777, is_bot: false },
      ...(groupId ? { media_group_id: groupId } : {}),
      ...(caption ? { caption } : {}),
      photo: [
        { file_id: `${fileId}-small`, width: 90, height: 90 },
        { file_id: fileId, width: 1280, height: 960 },
      ],
    },
  }
}

// Kills: dropping the is_bot guard. The bot's own lines come back as
// updates in a group; a bridge that answers itself loops forever, and
// every loop costs a model call.
test('a bot never talks to itself', () => {
  assert.equal(toFacts(message({ from: { id: 1, is_bot: true } })), null)
})

// Kills: reading only `text`. A photo carries its words in `caption`, so
// a captioned photo would arrive with the dispatcher's sentence missing.
test('a caption is the photo turn text', () => {
  const fact = factsForBatch([photoUpdate({ updateId: 5, caption: 'BOL for 4471', fileId: 'AAA' })])
  assert.equal(fact.text, 'BOL for 4471')
  // The largest size is the useful one.
  assert.deepEqual(fact.photos.map((p) => p.fileId), ['AAA'])
})

// Kills: taking the LAST caption of an album. The others carry none, and
// the dispatcher's words would change with whichever part arrived last.
test('an album is one turn and keeps its first caption', () => {
  const batch = [
    photoUpdate({ updateId: 5, groupId: 'g1', caption: 'first', fileId: 'AAA' }),
    photoUpdate({ updateId: 6, groupId: 'g1', fileId: 'BBB' }),
    photoUpdate({ updateId: 7, groupId: 'g1', caption: 'later', fileId: 'CCC' }),
  ]
  const fact = factsForBatch(batch)
  assert.equal(fact.text, 'first')
  assert.deepEqual(fact.photos.map((p) => p.fileId), ['AAA', 'BBB', 'CCC'])
  // Kills: moving the read position past only the first part, which
  // would re-read the rest of the album after a restart.
  assert.equal(lastUpdateId(batch), 7)
})

// Kills: folding every photo into one turn regardless of album, or
// losing the order the group typed in.
test('separate messages stay separate, in order', () => {
  const batches = batchUpdates([
    message({ text: 'one' }),
    { ...message({ text: 'two' }), update_id: 2 },
    photoUpdate({ updateId: 3, groupId: 'g9', caption: 'album', fileId: 'AAA' }),
    photoUpdate({ updateId: 4, groupId: 'g9', fileId: 'BBB' }),
    { ...message({ text: 'after' }), update_id: 5 },
  ])
  assert.equal(batches.length, 4)
  assert.deepEqual(batches.map((b) => b.length), [1, 1, 2, 1])
  assert.equal(factsForBatch(batches[3]).text, 'after')
})

// Kills: treating a reply like any other message. The reply id is how a
// dispatcher answers one driver without naming them.
test('a reply carries the id it answered', () => {
  assert.equal(factsForBatch([message({ reply_to_message: { message_id: 42 } })]).replyToTelegramMessageId, 42)
  assert.equal(factsForBatch([message()]).replyToTelegramMessageId, null)
})

// Kills: forwarding stickers, joins, locations and every other update
// shape into a driver thread as an empty message.
test('an update with neither text nor a photo is not a message', () => {
  assert.equal(toFacts(message({ text: undefined })), null)
  assert.equal(toFacts({ update_id: 3 }), null)
  assert.equal(factsForBatch([{ update_id: 3 }]), null)
})

// The vision switch: a photo either reaches the model or the bot says
// honestly that it cannot look. Pure tests for the decisions.
//
// The critical mutation these kill: handing a blind model an image and
// passing its reply off as having "seen" the photo. The switch defaults
// to off, and off means the caption travels and the bytes do not.
//
// The attachment-row test went with migration 049: the table kept the
// file side of a photo for the 046/047 bridge, the folded bot keeps no
// record of one, and the test asserted on a table that no longer exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { photoDecision, incomingRecordText, BLIND_PHOTO_NOTICE } from '../src/bot/vision.js'
import { buildMessages } from '../src/modules/driverChat/driverChat.prompt.js'

// (The two collectPhotos tests live in botParse.test.js now, next to the
// function they exercise -- parse.js folded in with the bot, and the
// old telegram_bot/test/parse.test.js folder went away with it.)

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

// The seams that keep the character intact on the way out.
//
// In the app thread the driver's reply is text in a bubble; in the
// Telegram chat it is a line the BOT sends, and three habits of a bot
// can leak through it: a name on every message, an answer that pops in
// fully formed, and infrastructure words spoken in the driver's voice.
// Each test here kills one.
//
// Pure or fake-dependent: no database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lineFor, pushDue, TICK_SEC } from '../src/bot/outgoing.js'
import { systemLine } from '../src/bot/loop.js'
import config from '../src/config.js'

// -- lineFor: the prefix is the door, not a habit -------------------------

test('a line from the configured driver goes out bare — the chat is the person', () => {
  const fixed = config.telegramDriverName
  assert.ok(fixed, 'bu test TELEGRAM_DRIVER_NAME sozlangan muhitni kutadi')
  const line = lineFor({ driverName: fixed, truckId: 'RS-9278-CY', content: 'On my ten' })
  assert.equal(line, 'On my ten')
  // Kills: keeping formatDriverMessage's prefix unconditionally -- the
  // private chat would read every text as "Grace Lindqvist · RS-9278-CY",
  // which is how a machine signs its texts, not how a person does.
})

test('a line from any other driver keeps the name prefix', () => {
  const line = lineFor({ driverName: 'Marcus Hale', truckId: 'TRK-104', content: 'On my ten' })
  assert.equal(line, 'Marcus Hale · TRK-104\nOn my ten')
  // Kills: dropping the prefix for everyone -- the shared chat would
  // have no way to tell whose voice a line is.
})

test('the fixed-name comparison is case- and padding-proof', () => {
  const fixed = config.telegramDriverName
  const line = lineFor({ driverName: `  ${String(fixed).toUpperCase()}  `, truckId: null, content: 'copy that' })
  assert.equal(line, 'copy that')
  // Kills: an exact === against config -- a driver named with different
  // spacing or case in the roster would suddenly grow a prefix again.
})

// -- systemLine: the office never speaks in the driver's voice ------------

test('infrastructure words carry the [system] prefix', () => {
  assert.equal(systemLine('The chat provider is not answering right now.'), '[system] The chat provider is not answering right now.')
  // Kills: saying system replies bare -- in a private chat they would
  // sit in the thread as if Grace had said them.
})

test('the prefix survives concatenation with help and status output', () => {
  const out = systemLine('Keystone Line Haul — driver dispatch\n\nJust type.')
  assert.ok(out.startsWith('[system] '))
  // Kills: a prefix applied only to single-line strings.
})

// -- typing: the answer is preceded by an indicator ------------------------

test('sendChatAction is called before the message goes out', async () => {
  const order = []
  const rows = [{
    id: 'm1', content: 'On my way', deliverAt: new Date('2026-09-29T12:00:00Z'),
    deliverAtText: '2026-09-29T12:00:00.000000Z', driverId: 'd11',
    driverName: config.telegramDriverName, truckId: 'RS-9278-CY',
  }]
  const telegram = {
    async sendChatAction() { order.push('typing') },
    async sendMessage(_chatId, text) { order.push(`sent:${text}`); return { message_id: 1 } },
  }
  const saved = []
  await pushDue({
    state: { deliveredThrough: ['2026-09-29T11:00:00.000000Z', 'm0'], targets: {} },
    chatId: 42, userId: 'u1', telegram, save: (s) => saved.push(s), due: async () => rows, gapMs: 0,
  })
  assert.equal(order[0], 'typing')
  assert.ok(order[1]?.startsWith('sent:'))
  // Kills: removing the indicator call, or sending first and "typing"
  // after -- the persona would answer like a machine again.
})

// -- the piece the others lean on -----------------------------------------

test('the delivery tick is still 15 seconds', () => {
  assert.equal(TICK_SEC, 15)
})

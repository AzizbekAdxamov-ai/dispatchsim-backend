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
  const at = {}
  const telegram = {
    async sendChatAction() { order.push('typing'); at.typing = Date.now() },
    async sendMessage(_chatId, text) { order.push(`sent:${text}`); at.sent = Date.now(); return { message_id: 1 } },
  }
  const saved = []
  await pushDue({
    state: { deliveredThrough: ['2026-09-29T11:00:00.000000Z', 'm0'], targets: {} },
    chatId: 42, userId: 'u1', telegram, save: (s) => saved.push(s), due: async () => rows, gapMs: 0,
    typingMs: 40,
  })
  assert.equal(order[0], 'typing')
  assert.ok(order[1]?.startsWith('sent:'))
  // Kills: removing the indicator call, or sending first and "typing"
  // after -- the persona would answer like a machine again.

  // Kills: sending the message straight after the indicator. Telegram
  // clears "typing…" the moment a message from the bot arrives, so with
  // no wait between the two calls the indicator is never on a screen --
  // which is exactly how it first shipped (72de178), with the test above
  // green the whole time, because order alone cannot see a gap of zero.
  assert.ok(at.sent - at.typing >= 35, `yozish belgisi ${at.sent - at.typing} ms ko'rindi — xabar uni darhol o'chiradi`)
})

// Kills: waiting for an indicator that never went out. A failed
// sendChatAction is harmless; five seconds of silence after it is not.
test('no wait when the typing indicator could not be sent', async () => {
  const rows = [{
    id: 'm2', content: 'copy that', deliverAt: new Date('2026-09-29T12:00:00Z'),
    deliverAtText: '2026-09-29T12:00:00.000000Z', driverId: 'd11',
    driverName: config.telegramDriverName, truckId: 'RS-9278-CY',
  }]
  const telegram = {
    async sendChatAction() { throw new Error('telegram sendChatAction: network error') },
    async sendMessage() { return { message_id: 2 } },
  }
  const started = Date.now()
  await pushDue({
    state: { deliveredThrough: ['2026-09-29T11:00:00.000000Z', 'm0'], targets: {} },
    chatId: 42, userId: 'u1', telegram, save: () => {}, due: async () => rows, gapMs: 0,
    typingMs: 400,
  })
  assert.ok(Date.now() - started < 300, 'ko\'rinmagan belgi uchun kutildi')
})

// -- the piece the others lean on -----------------------------------------

test('the delivery tick is still 15 seconds', () => {
  assert.equal(TICK_SEC, 15)
})

// -- the persona reaches the model -----------------------------------------
//
// Seven tests above and none of them could see the one thing stage 4 was
// for: deleting the line that puts drivers.bio into the prompt left every
// one of them green. The persona was in the database, on the profile
// page, and -- as far as any test could tell -- optional in the prompt.

import { buildDriverSystemPrompt } from '../src/modules/driverChat/driverChat.prompt.js'

const STANDING = { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 }
const GRACE = {
  id: 'd11', name: 'Grace Lindqvist', cdlClass: 'A',
  homeBaseCity: 'Seattle', homeBaseState: 'WA',
  dutyStatus: 'resting', payModel: 'permile', payPerMileCents: 62,
  truckId: 'RS-9278-CY', currentCity: 'Seattle', currentState: 'WA',
  hosRemainingMin: 581, fuelGallons: 150, fuelCapacityGal: 240,
  bio: '\n  Says "copy that" when she agrees and calls the trailer "the box".\n',
}

// Kills: dropping the bio from the prompt, or dropping the header that
// tells the model the third-person description is itself.
test('the bio from the database is in the prompt, under a header that says it is you', () => {
  const prompt = buildDriverSystemPrompt({ driver: GRACE, standing: STANDING, load: null })
  assert.match(prompt, /PERSONALITY \(this is you/)
  assert.match(prompt, /calls the trailer "the box"/)
})

// Kills: printing an empty PERSONALITY header for a driver with no bio --
// every driver but one. An empty heading is an instruction with nothing
// in it, and the model fills silence with invention.
test('no bio, no personality block', () => {
  for (const bio of [null, undefined, '   \n  ']) {
    const prompt = buildDriverSystemPrompt({ driver: { ...GRACE, bio }, standing: STANDING, load: null })
    assert.doesNotMatch(prompt, /PERSONALITY/, `bio=${JSON.stringify(bio)}`)
  }
})

// Kills: losing the in-character answer to "are you a bot". Without it
// the model's own default is to say what it is, in the one chat the
// persona exists for.
test('the prompt says how to answer "are you a bot" in character', () => {
  const prompt = buildDriverSystemPrompt({ driver: GRACE, standing: STANDING, load: null })
  assert.match(prompt, /asks whether you are a bot/)
  assert.match(prompt, /You do not know what a prompt or a\s+model is/)
})

// Kills: small talk about her getting "No idea", an invented family, or a
// prompt-ask answer that never turns back to work.
test('the prompt answers small talk warmly and turns every deflection back to work', () => {
  const prompt = buildDriverSystemPrompt({ driver: GRACE, standing: STANDING, load: null })
  assert.match(prompt, /"No idea" is for facts/)
  assert.match(prompt, /turn back to work/)
  assert.match(prompt, /name no one/)
})

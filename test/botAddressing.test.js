// A group with two dispatchers in it: the driver hears only what is
// meant for her.
//
// Azizbek, 2026-10-01: the bot goes into a group with a second
// dispatcher, and the two of them talk to each other there. Every line
// of that talk reaching the driver would put answers in her mouth about
// a conversation she was never in, and spend a model call on each one.
// A reply to her, an @mention of the bot, or her name reaches her;
// commands always reach the bot; a private chat is unchanged.
//
// Every test names the mutation it kills. No network, no database: the
// loop gets a fake Telegram and a fake app, as in botLoop.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isGroupChat, callName, mentionsName, mentionsBot, stripBotMention, addressedToDriver,
} from '../src/bot/addressing.js'
import { toFacts } from '../src/bot/parse.js'
import { routeUpdate } from '../src/bot/router.js'
import { pollOnce } from '../src/bot/loop.js'
import { handleUpdate, helpText } from '../src/bot/incoming.js'
import { EMPTY } from '../src/bot/state.js'

const BOT = 'DispatchDeskBot'
const GRACE = 'Grace Lindqvist'
const GROUP = { chatId: '-100500', chatType: 'supergroup' }

const fact = (over = {}) => ({ ...GROUP, text: 'did you book the Dallas one?', replyToTelegramMessageId: null, replyToFromBot: false, replyToUsername: null, ...over })
const heard = (over) => addressedToDriver(fact(over), { botUsername: BOT, driverName: GRACE })

// -- What counts as a group ---------------------------------------------

// Kills: treating every chat as a group (a private chat would stop
// answering) or none (the filter would never apply).
test('a group is a group by type, and by a negative id when the type is missing', () => {
  assert.equal(isGroupChat('supergroup', '-1001'), true)
  assert.equal(isGroupChat('group', '-5'), true)
  assert.equal(isGroupChat('private', '6686277144'), false)
  assert.equal(isGroupChat(null, '-100500'), true)
  assert.equal(isGroupChat(null, '6686277144'), false)
})

// -- Who is being talked to ---------------------------------------------

// Kills: the filter applied to a private chat. There is nobody else to
// talk to there; every message is for the driver.
test('in a private chat every message reaches the driver', () => {
  assert.equal(heard({ chatId: '6686277144', chatType: 'private' }), true)
})

// Kills: no filter at all -- the two people's cross-talk answered.
test('in a group, the two people talking to each other are left alone', () => {
  assert.equal(heard({}), false)
  assert.equal(heard({ text: 'ok I will call the broker' }), false)
})

// Kills: dropping any one of the three ways in.
test('in a group, a reply to the bot, an @mention or her name reaches her', () => {
  assert.equal(heard({ replyToTelegramMessageId: 42, replyToFromBot: true, replyToUsername: BOT }), true)
  assert.equal(heard({ text: `@${BOT} where are you` }), true)
  assert.equal(heard({ text: `@${BOT.toLowerCase()} eta?` }), true)
  assert.equal(heard({ text: 'Grace, where are you?' }), true)
  assert.equal(heard({ text: 'hey grace eta' }), true)
})

// Kills: treating every reply as for the driver. In a group, a reply to
// the OTHER DISPATCHER is part of their conversation.
test('in a group, a reply to the other person is not a reply to her', () => {
  assert.equal(heard({ replyToTelegramMessageId: 42, replyToFromBot: false, replyToUsername: 'azizbek' }), false)
  assert.equal(heard({ replyToTelegramMessageId: 42, replyToFromBot: true, replyToUsername: 'SomeOtherBot' }), false)
  // Even with the bot's own handle unknown, a person's message is a person's.
  assert.equal(addressedToDriver(fact({ replyToTelegramMessageId: 42, replyToFromBot: false }), { driverName: GRACE }), false)
  assert.equal(addressedToDriver(fact({ replyToTelegramMessageId: 42, replyToFromBot: true }), { driverName: GRACE }), true)
})

// Kills: a substring match. "Graceland" is a place, not her name.
test('her name counts only as a whole word', () => {
  assert.equal(mentionsName('the load to Graceland', 'Grace'), false)
  assert.equal(mentionsName('Grace!', 'Grace'), true)
  assert.equal(mentionsName('ask grace', 'Grace'), true)
  assert.equal(mentionsName('anything', null), false)
  assert.equal(callName(GRACE), 'Grace')
  assert.equal(callName(''), null)
})

// Kills: a command in a group filtered away -- /status would go
// unanswered unless someone also typed her name.
test('in a group, commands always reach the bot', () => {
  assert.equal(heard({ text: '/status' }), true)
  assert.equal(heard({ text: `/help@${BOT}` }), true)
})

// Kills: an @mention left in the words the driver reads.
test('the @mention is taken out of what the driver reads', () => {
  assert.equal(stripBotMention(`@${BOT} where are you`, BOT), 'where are you')
  assert.equal(stripBotMention(`@${BOT}, eta?`, BOT), 'eta?')
  assert.equal(stripBotMention('Grace, eta?', BOT), 'Grace, eta?')
  assert.equal(mentionsBot('no handle here', BOT), false)
})

// -- What Telegram sends -------------------------------------------------

// Kills: parse.js not carrying who wrote the replied-to message -- the
// filter would see every reply as a reply to the bot, or none.
test('a reply carries who wrote the message it replies to', () => {
  const f = toFacts({
    update_id: 1,
    message: {
      message_id: 5, chat: { id: -100500, type: 'supergroup' }, from: { id: 7, is_bot: false }, text: 'yes',
      reply_to_message: { message_id: 4, from: { id: 99, is_bot: true, username: BOT } },
    },
  })
  assert.equal(f.replyToFromBot, true)
  assert.equal(f.replyToUsername, BOT)
  const plain = toFacts({ update_id: 2, message: { message_id: 6, chat: { id: -1, type: 'group' }, from: { id: 7 }, text: 'x' } })
  assert.equal(plain.replyToFromBot, false)
})

// Kills: "/status@Bot" falling through to the driver as a sentence --
// Telegram writes a command picked from the menu that way in a group.
test('a command with this bot\'s handle is that command; another bot\'s is ignored', () => {
  assert.equal(routeUpdate({ text: `/status@${BOT}`, botUsername: BOT }).kind, 'status')
  assert.equal(routeUpdate({ text: `/d@${BOT} Grace`, botUsername: BOT }).kind, 'set-driver')
  assert.equal(routeUpdate({ text: '/status@SomeOtherBot', botUsername: BOT }).kind, 'ignore')
  assert.equal(routeUpdate({ text: '/status' }).kind, 'status')
})

// -- The loop ------------------------------------------------------------

function update(id, over = {}) {
  return {
    update_id: id,
    message: { message_id: 100 + id, chat: { id: -100500, type: 'supergroup' }, from: { id: 777, is_bot: false }, text: `message ${id}`, ...over },
  }
}

function fakes() {
  const sent = []
  const said = []
  const driver = { id: 'd11', name: GRACE, dutyStatus: 'driving' }
  const app = {
    driversByName: async () => [driver],
    driversList: async () => [driver],
    driverById: async () => driver,
    getCarrier: async () => ({ name: 'Keystone Line Haul' }),
    getDriverContext: async () => ({ driver: { ...driver, truckId: null } }),
    openConversation: async ({ driverId }) => ({ conversation: { id: `conv-${driverId}` } }),
    sendMessage: async (payload) => { sent.push(payload) },
  }
  const telegram = {
    said,
    async getUpdates() { return [] },
    async sendMessage(_c, text) { said.push(text); return { message_id: 9000 + said.length } },
  }
  return { app, telegram, sent, said }
}

// Kills: the loop not consulting the filter, and the filter's skip
// holding the read position (the cross-talk would be re-read forever).
test('the loop passes cross-talk by, reads past it, and delivers what is addressed', async () => {
  const { app, telegram, sent } = fakes()
  telegram.getUpdates = async () => [
    update(1, { text: 'did you book the Dallas one?' }),
    update(2, { text: `@${BOT} where are you now` }),
  ]
  const saved = []
  await pollOnce({
    telegram, state: { ...EMPTY }, save: (s) => saved.push(s),
    chatId: -100500, userId: 'u1', app, fixedDriverName: GRACE, botUsername: BOT,
  })
  assert.equal(sent.length, 1, `delivered: ${JSON.stringify(sent)}`)
  assert.equal(sent[0].text, 'where are you now')
  assert.equal(saved.at(-1).offset, 3)
})

// Kills: the group line missing from /help in a group, or shown in a
// private chat where it means nothing.
test('help in a group says how to reach her; in a private chat it does not', () => {
  const driver = { name: GRACE, truckId: null }
  assert.match(helpText('Keystone', driver, { group: true }), /reply to Grace's message, or say "Grace"/)
  assert.doesNotMatch(helpText('Keystone', driver), /In this group/)
})

// Kills: handleUpdate not passing the chat type through to help.
test('/help typed in the group gets the group line', async () => {
  const { app } = fakes()
  const r = await handleUpdate(fact({ text: `/help@${BOT}` }), { state: { ...EMPTY }, app, userId: 'u1', fixedDriverName: GRACE, botUsername: BOT })
  assert.match(r.replies.join('\n'), /In this group/)
})

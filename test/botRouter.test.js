// The router decides what a message MEANS, without touching anything.
// Pure-function tests: no database, no network, no timers.
//
// Each test names the mutation it kills. The ask-who test is the one that
// matters most: a bridge that guesses a recipient puts words in the
// wrong driver's mouth, and nothing anywhere would show the mistake.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { routeUpdate } from '../src/bot/router.js'
// The words themselves live beside the help they replace.
import { usageText } from '../src/bot/incoming.js'

test('/link with a code routes to link, upper-cased', () => {
  assert.deepEqual(routeUpdate({ text: '/link ab12cd' }), { kind: 'link', code: 'AB12CD' })
})

// Kills: answering a half-typed command with the command list. Both of
// these used to return { kind: 'help' }, and help is four commands and a
// paragraph -- everything except the one word that was missing.
test('/link without a code says the code is missing, not the whole list', () => {
  assert.deepEqual(routeUpdate({ text: '/link' }), { kind: 'usage', command: 'link' })
  assert.deepEqual(routeUpdate({ text: '/link   ' }), { kind: 'usage', command: 'link' })
})

test('/d routes to set-driver with the name verbatim', () => {
  assert.deepEqual(routeUpdate({ text: '/d Marcus Hale' }), { kind: 'set-driver', name: 'Marcus Hale' })
  assert.deepEqual(routeUpdate({ text: '/d    Marcus   ' }), { kind: 'set-driver', name: 'Marcus' })
})

test('/d without a name says the name is missing, and is never ask-who', () => {
  assert.deepEqual(routeUpdate({ text: '/d' }), { kind: 'usage', command: 'd' })
})

test('/drivers and /help route to their kinds; case of the command word is irrelevant', () => {
  assert.deepEqual(routeUpdate({ text: '/DRIVERS' }), { kind: 'drivers' })
  assert.deepEqual(routeUpdate({ text: '/Help' }), { kind: 'help' })
})

test('an unknown command is ignored, not delivered to a driver', () => {
  // Kills: `default: { kind: 'ask-who' }` -- '/delivered to Boston' typed
  // as a command would fall through to a driver thread.
  assert.deepEqual(routeUpdate({ text: '/delivered to Boston' }), { kind: 'ignore' })
  assert.deepEqual(routeUpdate({ text: '/linkx abc123' }), { kind: 'ignore' })
})

test('a reply routes to-driver even when a current driver is set', () => {
  // Kills: checking currentDriverId before the reply -- the standing /d
  // would swallow replies aimed at a different driver's message.
  assert.deepEqual(
    routeUpdate({ text: 'Copy that.', replyToTelegramMessageId: 4242, currentDriverId: 'd1' }),
    { kind: 'to-driver', replyToTelegramMessageId: 4242 },
  )
})

test('plain text with no reply goes to the current driver', () => {
  assert.deepEqual(
    routeUpdate({ text: 'On my way', currentDriverId: 'd7' }),
    { kind: 'to-current', driverId: 'd7' },
  )
})

test('nothing names a recipient: ask-who, never a guess', () => {
  // Kills: defaulting to the first driver, the last conversation, or any
  // other silent choice. (The fixed-driver arrangement is not a guess:
  // it is named in .env, resolved against the roster, and checked at
  // boot -- see handleUpdate's ask-who branch.)
  assert.deepEqual(routeUpdate({ text: 'Ok, ketdim' }), { kind: 'ask-who' })
  assert.deepEqual(routeUpdate({ text: 'Ok, ketdim', replyToTelegramMessageId: null, currentDriverId: null }), { kind: 'ask-who' })
})

test('empty text is still routed by context, not dropped', () => {
  assert.deepEqual(routeUpdate({ text: '', currentDriverId: 'd3' }), { kind: 'to-current', driverId: 'd3' })
  assert.deepEqual(routeUpdate({ text: '' }), { kind: 'ask-who' })
})

test('commands are commands even as replies', () => {
  // Kills: reading the reply target before the command parse -- /link
  // typed as a reply would bind the wrong chat or leak into a thread.
  assert.deepEqual(
    routeUpdate({ text: '/drivers', replyToTelegramMessageId: 99 }),
    { kind: 'drivers' },
  )
})

// Kills: a usage sentence that is the help list under another name. The
// text the bot sends is the whole value of this change -- routing to a
// different kind and then printing the same four commands would pass
// every assertion above.
test('the usage sentence names the missing word and nothing else', () => {
  // /link survives as a courtesy: codes bound a chat to one of many
  // student accounts, and there is one dispatcher and one group now,
  // both named in .env. The honest answer is that there is nothing to
  // bind -- not a stale instruction to fetch a code from a panel that no
  // longer offers one.
  const link = usageText('link')
  assert.match(link, /No code needed/, 'yangi holat aytilmayapti')
  assert.doesNotMatch(link, /\/link ABC123/, 'eskirgan kod namunasi qaytyapti')
  assert.doesNotMatch(link, /\/help/, 'yana butun ro\'yxat chiqyapti')
  assert.doesNotMatch(link, /\/drivers/, 'yana butun ro\'yxat chiqyapti')

  const d = usageText('d')
  assert.match(d, /\/d Marcus/, 'ism namunasi ko\'rsatilmayapti')
  assert.match(d, /\/drivers/, 'ro\'yxatni qanday ko\'rishi aytilmayapti')
})

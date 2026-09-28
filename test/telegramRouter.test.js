// The router decides what a message MEANS, without touching anything.
// Pure-function tests: no database, no network, no timers.
//
// Each test names the mutation it kills. The ask-who test is the one that
// matters most: a bridge that guesses a recipient puts words in the
// wrong driver's mouth, and nothing anywhere would show the mistake.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { routeUpdate } from '../src/modules/telegram/telegram.router.js'

test('/link with a code routes to link, upper-cased', () => {
  assert.deepEqual(routeUpdate({ text: '/link ab12cd' }), { kind: 'link', code: 'AB12CD' })
})

test('/link without a code asks for help instead of guessing', () => {
  assert.deepEqual(routeUpdate({ text: '/link' }), { kind: 'help' })
  assert.deepEqual(routeUpdate({ text: '/link   ' }), { kind: 'help' })
})

test('/d routes to set-driver with the name verbatim', () => {
  assert.deepEqual(routeUpdate({ text: '/d Marcus Hale' }), { kind: 'set-driver', name: 'Marcus Hale' })
  assert.deepEqual(routeUpdate({ text: '/d    Marcus   ' }), { kind: 'set-driver', name: 'Marcus' })
})

test('/d without a name asks for help, not ask-who', () => {
  assert.deepEqual(routeUpdate({ text: '/d' }), { kind: 'help' })
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
  // other silent choice.
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

// "Can't make that pickup": the words, and the services that regenerate on
// a reply that leaves them out when the facts say the truck cannot make it.
//
// Eval 2026-10-15 (live:60): a driver replied "Copy that. Need pickup
// address, miles and drop details." to a pickup she could not reach.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { saysCannotMake, ignoresUnreachable } from '../src/lib/cannotMake.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n')

const LIVE60 = 'Copy that. Need pickup address, miles and drop details.'

// Kills: the fold removed (a curly apostrophe in "Can’t" slips past
// the \bcan'?t pattern), and "not gonna" dropped from the list.
test('the live:60 reply does not say the pickup cannot be made; the ways of saying it do', () => {
  assert.equal(saysCannotMake(LIVE60), false)
  assert.equal(saysCannotMake('Can’t make 8am'), true)
  assert.equal(saysCannotMake('Not gonna make that, earliest I could be there is Sun.'), true)
  assert.equal(saysCannotMake('Not gonna make that one.'), true)
  assert.equal(saysCannotMake('Earliest I can be there is Sun.'), true)
  assert.equal(saysCannotMake('Too far.'), true)
})

// Kills: `=== false` loosened to `!facts?.makesIt` (null and a missing
// verdict would then demand the sentence on every load).
test('only a computed "cannot" asks for the fact', () => {
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: false }), true)
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: true }), false)
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: null }), false)
  assert.equal(ignoresUnreachable(LIVE60, null), false)
  assert.equal(ignoresUnreachable(LIVE60, undefined), false)
})

// Kills: BROKER_LATE applied to the driver check unconditionally, and
// BROKER_LATE removed (the broker's own way of saying it not counted).
test('the broker may say it as "after your pickup"; the driver check does not take that', () => {
  const late = 'That gets you here Saturday, after your Friday 8 AM pickup.'
  assert.equal(saysCannotMake(late, { broker: true }), true)
  assert.equal(saysCannotMake(late), false)
  assert.equal(ignoresUnreachable('Where is your truck at?', { makesIt: false }, { broker: true }), true)
})

// Kills: a service that stops checking the computed fact, checks it against
// a different clock than the prompt's, or adds a third chatText call
// (turnLog.test.js pins exactly two).
test('the services regenerate on an unreachable pickup through the one existing second call', () => {
  const driver = read('src', 'modules', 'driverChat', 'driverChat.service.js')
  assert.match(driver, /const offer = offerFacts\(/)
  assert.match(driver, /ignoresUnreachable\(reply, offer\)/)
  assert.match(driver, /unusableWhy \?\? \(missedPickup/)
  const broker = read('src', 'modules', 'brokerChat', 'brokerChat.service.js')
  assert.match(broker, /truckFacts\(\{ texts: said, posting, now \}\)/)
  assert.match(broker, /ignoresUnreachable\(reply, truck, \{ broker: true \}\)/)
  assert.match(broker, /buildBrokerSystemPrompt\(\{[\s\S]*?\bnow\b/)
  assert.match(broker, /unusableWhy \?\? \(missedPickup/)
  for (const src of [driver, broker]) {
    assert.equal(src.match(/await chatText\(\{/g).length, 2)
  }
})

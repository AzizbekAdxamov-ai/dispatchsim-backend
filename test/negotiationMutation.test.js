import test from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent } from '../src/modules/brokerChat/negotiation.js'

// These small mutants model the regressions that caused live turns #173–#196.
// Each assertion proves the production classifier distinguishes the mutant.
const mutants = {
  narrowBookIt: (text) => /^ok book it$/i.test(text) ? { kind: 'accept' } : { kind: 'talk' },
  noStreetNormalization: (text) => /\bwhat do you have in it\b/i.test(text) ? { kind: 'ask_room' } : { kind: 'talk' },
  noKiloAmount: (text) => /\bif you can do \$?\d+\b/i.test(text) ? { kind: 'close_at' } : { kind: 'talk' },
}

test('book-it loop mutation is killed by apostrophe-free acceptance', () => {
  const input = 'ok lets book it'
  assert.equal(chatIntent(input).kind, 'accept')
  // Kills: reverting ACCEPT to the old exact "ok book it" expression.
  assert.notDeepEqual(chatIntent(input), mutants.narrowBookIt(input))
})

test('street wording mutation is killed by room intent coverage', () => {
  const input = 'what do u have in it'
  assert.equal(chatIntent(input).kind, 'ask_room')
  // Kills: removing apostrophe-free/u variants from KEY_INTENTS.ask_room.
  assert.notDeepEqual(chatIntent(input), mutants.noStreetNormalization(input))
})

test('3.6k close mutation is killed by amount normalization', () => {
  const input = 'if u can do 3.6k ill take it now'
  assert.equal(chatIntent(input).kind, 'accept_amount')
  // Kills: treating k amounts as unrecognized text.
  assert.notDeepEqual(chatIntent(input), mutants.noKiloAmount(input))
})

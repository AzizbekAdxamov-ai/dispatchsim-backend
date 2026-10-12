// A model playing a person sometimes opens with its own name ("Grace: I'm
// good..."). The services strip that before saving; the rule lives in
// src/lib/speakerLabel.js and is pinned here.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripSpeakerLabel } from '../src/lib/speakerLabel.js'

test('a leading "Name:" is removed, case-insensitively', () => {
  // Kills: label left in the saved reply, or the match being case-sensitive
  // (the model wrote "GRACE:" / "grace:").
  assert.equal(stripSpeakerLabel("Grace: I'm good, rolling now.", 'Grace Miller'), "I'm good, rolling now.")
  assert.equal(stripSpeakerLabel("  grace :  I'm good.", 'Grace Miller'), "I'm good.")
  assert.equal(stripSpeakerLabel('GRACE: ok', 'Grace Miller'), 'ok')
})

test('the full name is removed whole, not left as "Miller:"', () => {
  // Kills: only the first name being matched, leaving "Miller: ..." behind.
  assert.equal(stripSpeakerLabel('Grace Miller: Running late.', 'Grace Miller'), 'Running late.')
})

test('markdown bold around the label is removed', () => {
  // Kills: bold variants "**Grace:**" / "**Grace**:" slipping through.
  assert.equal(stripSpeakerLabel('**Grace:** On my way.', 'Grace Miller'), 'On my way.')
  assert.equal(stripSpeakerLabel('**Grace**: On my way.', 'Grace Miller'), 'On my way.')
})

test('a name inside the sentence is kept', () => {
  // Kills: stripping the name anywhere in the text instead of only as a
  // leading speaker label.
  const t = 'Tell Grace: the load is booked.'
  assert.equal(stripSpeakerLabel(t, 'Grace Miller'), t)
  const u = 'Grace said she is fine.'
  assert.equal(stripSpeakerLabel(u, 'Grace Miller'), u)
})

test('a reply with no prefix is unchanged', () => {
  // Kills: trimming or altering replies that never had a label.
  const t = "I'm good, thanks for asking."
  assert.equal(stripSpeakerLabel(t, 'Grace Miller'), t)
  assert.equal(stripSpeakerLabel(t, null), t)
})

test('the broker contact name is stripped the same way', () => {
  // Kills: the helper being hardcoded to one name instead of using the
  // name it is given (broker contact).
  assert.equal(stripSpeakerLabel('Devin Marlowe: Can do $2,400.', 'Devin Marlowe'), 'Can do $2,400.')
  assert.equal(stripSpeakerLabel('devin: Can do $2,400.', 'Devin Marlowe'), 'Can do $2,400.')
})

test('a reply that is only a label is kept, never emptied', () => {
  // Kills: returning an empty string, which would be saved and sent blank.
  assert.equal(stripSpeakerLabel('Grace:', 'Grace Miller'), 'Grace:')
})

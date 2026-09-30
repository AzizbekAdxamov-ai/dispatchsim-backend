// The delivered watermark and the state ownership rules.
//
// These kill the mutation that produced the worst live bug this bot has
// had (2026-09-29): a poll loop's stale snapshot assigned back over the
// outgoing tick's progress rewound the delivered watermark, and the same
// driver reply went to the chat three times. A watermark that can move
// backwards is not a watermark.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newerPair, mergeState, EMPTY, readState, writeState } from '../src/bot/state.js'

// Kills: `return a ?? b` -- treating a missing timestamp as "newer",
// which would rewind a real watermark to null on every cold snapshot.
test('newerPair keeps the later deliver_at, whatever the argument order', () => {
  const early = ['2026-09-29T12:00:00.000Z', 'aaa']
  const late = ['2026-09-29T12:36:33.918Z', 'bbb']

  assert.equal(newerPair(early, late), late)
  assert.equal(newerPair(late, early), late)
  assert.equal(newerPair(early, early), early)
})

// Kills: `a ?? b` again, from the other side -- a null snapshot must
// never erase a watermark the outgoing tick already advanced.
test('newerPair: a null side loses to a real pair', () => {
  const real = ['2026-09-29T12:36:33.918Z', 'bbb']
  assert.equal(newerPair(null, real), real)
  assert.equal(newerPair(real, null), real)
  assert.equal(newerPair(undefined, real), real)
})

// Both sides empty is the cold start: nothing delivered, nothing to keep.
test('newerPair: two nulls stay null', () => {
  assert.equal(newerPair(null, null), null)
})

// The id half of the pair matters only when the timestamps tie -- two
// replies due in the same millisecond. ISO strings order correctly as
// strings, so this is a string compare in both places.
test('newerPair breaks a timestamp tie by id, deterministically', () => {
  const a = ['2026-09-29T12:00:00.000Z', 'aaa']
  const b = ['2026-09-29T12:00:00.000Z', 'bbb']
  // Whichever wins, the choice must be stable -- a tie broken differently
  // on every comparison would flip the watermark back and forth.
  assert.equal(newerPair(a, b), newerPair(b, a))
})

// The integration half of the fix: the writer merges instead of
// assigning. This goes through a real state file so the whole write
// path is exercised, with a temp file no test shares.
test('a save with a stale view cannot rewind fields a newer writer advanced', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'botstate-')), 'state.json')

  const A = { ...EMPTY, offset: 100, deliveredThrough: null, currentDriverId: null, targets: {} }
  writeState(A, file)
  assert.deepEqual(readState(file), A)

  // The outgoing tick's write: watermark advances, a reply target is
  // remembered.
  const B = {
    ...A,
    offset: 100,
    deliveredThrough: ['2026-09-29T12:36:33.918Z', 'msg-1'],
    targets: { '532': 'd11' },
    currentDriverId: 'd11',
  }
  writeState(B, file)

  // The poll loop's write, based on the view it was handed BEFORE the
  // tick ran -- the exact shape of the live bug: offset moved on (its
  // own progress), everything else stale. mergeState is what index.js's
  // save() applies; replaying the merge here pins its contract.
  const stale = { ...A, offset: 102 }
  const merged = mergeState(B, stale)
  writeState(merged, file)

  const saved = readState(file)
  assert.equal(saved.offset, 102) // poll's own progress survives
  assert.equal(saved.deliveredThrough?.[0], '2026-09-29T12:36:33.918Z') // watermark NOT rewound
  assert.equal(saved.currentDriverId, 'd11') // driver NOT unselected
  assert.equal(saved.targets['532'], 'd11') // reply map NOT wiped

  unlinkSync(file)
})

// Kills: mergeState(incoming, current) swapped -- a swap would make the
// stale view win exactly the fields the fix exists to protect, while
// every simple assertion above still read like it passed on first glance
// because B and stale agree on offset here.
test('mergeState argument order matters: current first, incoming second', () => {
  const current = { ...EMPTY, offset: 5, deliveredThrough: ['2026-09-29T12:00:00.000Z', 'a'] }
  const incoming = { ...EMPTY, offset: 6, deliveredThrough: null }
  assert.equal(mergeState(current, incoming).deliveredThrough?.[0], '2026-09-29T12:00:00.000Z')
})

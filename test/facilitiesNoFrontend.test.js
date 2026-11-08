// The deployed API ships the backend repo alone (Vercel, 2026-11-08): an
// import-time read of ../frontend/src/data/usMap.js crashed every function
// with ENOENT. The land mask is read on first use and a missing file turns
// the mask off instead of crashing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isOnLand } from '../scripts/seed/facilities.js'

test('no land mask: isOnLand accepts the point instead of throwing', () => {
  // Kills: removing the `rings === null` guard -- iterating null throws.
  assert.equal(isOnLand(40, -100, null), true)
  assert.equal(isOnLand(35, -50, null), true)
})

test('with the mask the ocean is still water', () => {
  // Kills: a guard that also skips the real mask.
  assert.equal(isOnLand(35, -50), false)
  assert.equal(isOnLand(38.5, -98), true)
})

test('the frontend map is not read at import time', () => {
  // Kills: putting `loadNationRings()` back at module top level.
  const src = readFileSync(new URL('../scripts/seed/facilities.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /^const NATION_RINGS = loadNationRings\(\)/m)
  assert.match(src, /export function nationRings\(\)/)
})

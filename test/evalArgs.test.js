// The id-list flags of chat:eval (--case) and chat:scenarios (--scenario).
// Pure parsing; the scripts themselves call the model and are not run here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIdList } from '../scripts/evalAttempts.js'

// Kills: --case taking only one id, so EB04,ED07 was "unknown case" and a
// two-case rerun cost a whole run.
test('parseIdList reads a comma list after the flag', () => {
  assert.deepEqual(parseIdList(['broker', '--case', 'EB04,ED07'], '--case'), { ids: ['EB04', 'ED07'] })
  assert.deepEqual(parseIdList(['--scenario', 'S2'], '--scenario'), { ids: ['S2'] })
})

// Kills: the --flag=value form being ignored, which ran EVERY case.
test('parseIdList reads the = form', () => {
  assert.deepEqual(parseIdList(['--case=EB04,ED07'], '--case'), { ids: ['EB04', 'ED07'] })
})

// Kills: no flag turning into an error or an empty list (nothing would run).
test('parseIdList without the flag means everything', () => {
  assert.deepEqual(parseIdList(['broker', '--gap', '20'], '--case'), { ids: null })
})

// Kills: a flag with no value (or one that swallows the next flag) being
// read as "all", spending a full run's requests by accident.
test('parseIdList refuses a missing value', () => {
  assert.ok(parseIdList(['--case'], '--case').error)
  assert.ok(parseIdList(['--case', '--gap', '5'], '--case').error)
  assert.ok(parseIdList(['--case='], '--case').error)
})

// Kills: "EB04,,ED07" dropping the empty item quietly instead of saying the
// command line has a typo.
test('parseIdList refuses an empty item', () => {
  assert.ok(parseIdList(['--case', 'EB04,,ED07'], '--case').error)
  assert.ok(parseIdList(['--case=EB04,'], '--case').error)
})

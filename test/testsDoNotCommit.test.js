// No test may use the production transaction helper.
//
// db/pool.js's withTransaction COMMITs on success. Two tests once used it
// believing it rolled back, and every passing run wrote into the real
// company (see scripts/check-test-leaks.js). Schema-backed tests use
// test/helpers/rollback.js's inRollback, which always rolls back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('no test file calls withTransaction', () => {
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith('.test.js') && f !== 'testsDoNotCommit.test.js')
    .filter((f) => /\bwithTransaction\b/.test(readFileSync(join(here, f), 'utf8')))
  assert.deepEqual(offenders, [])
})

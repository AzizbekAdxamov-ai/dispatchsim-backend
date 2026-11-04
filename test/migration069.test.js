import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (file) => readFileSync(join(process.cwd(), file), 'utf8')

// Kills: a pending close saved without a column, or with a non-positive amount
test('069 adds a nullable pending_close_usd that must be positive', () => {
  const sql = read('src/db/migrations/069_pending_close.sql')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS pending_close_usd integer NULL/i)
  assert.match(sql, /CHECK \(pending_close_usd IS NULL OR pending_close_usd > 0\)/i)
})

// Kills: the repository forgetting to read, write or clear the column
test('the repository reads, writes and clears pending_close_usd', () => {
  const repo = read('src/modules/brokerChat/brokerChat.repository.js')
  assert.match(repo, /c\.pending_close_usd AS "pendingCloseUsd"/)
  assert.match(repo, /pending_close_usd = \$14::integer/)
  assert.match(repo, /pending_close_usd = CASE WHEN \$3 THEN NULL ELSE pending_close_usd END/)
  assert.match(repo, /pending_close_usd = NULL,\s+negotiation_stage = 'held'/)
})

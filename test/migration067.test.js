import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('067 broker block migration uses the single-row carrier key and required fields', () => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/067_broker_blocks.sql'), 'utf8')
  assert.match(sql, /carrier_id\s+boolean/i)
  assert.match(sql, /blocked_until/i)
  assert.match(sql, /conversation_id/i)
  assert.match(sql, /broker_mc/i)
  // Kills: dropping the broker block table or changing carrier_id to a UUID.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS broker_blocks/i)
})

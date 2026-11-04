#!/usr/bin/env node
// broker-unblock.js — one-off removal of specific broker_blocks rows.
//
// There is no unblock path in the app: broker_blocks is only written when a
// carrier cancels (brokerChat.repository.js) and only read by the board and
// the chat. A block created by a false positive has to be removed by hand.
//
// Usage:
//   node scripts/broker-unblock.js <block-uuid> [<block-uuid> ...]            # dry run
//   node scripts/broker-unblock.js <block-uuid> ... --confirm                 # delete
//   (add --allow-remote to run against a non-local database)

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── 1. Host guard (same rule as clear-fleet.js) ──────────────────────────
const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const host = new URL(DB_URL).hostname
if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
  console.error(`refuses to delete from ${host} without --allow-remote`)
  process.exit(1)
}

// ── 2. Arguments ─────────────────────────────────────────────────────────
const CONFIRM = process.argv.includes('--confirm')
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (ids.length === 0) {
  console.error('usage: node scripts/broker-unblock.js <block-uuid> [...] [--confirm]')
  process.exit(1)
}
const malformed = ids.filter((id) => !UUID_RE.test(id))
if (malformed.length > 0) {
  console.error(`not a UUID: ${malformed.join(', ')}`)
  process.exit(1)
}
if (new Set(ids).size !== ids.length) {
  console.error('duplicate ids in the arguments')
  process.exit(1)
}

// ── 3. SQL ───────────────────────────────────────────────────────────────
const SELECT_SQL = `
  SELECT b.id, br.name AS "brokerName", b.broker_mc AS "brokerMc",
         b.broker_contact AS "brokerContact", b.blocked_until AS "blockedUntil",
         b.reason, b.conversation_id AS "conversationId"
    FROM broker_blocks b
    LEFT JOIN brokers br ON br.id = b.broker_id
   WHERE b.id = ANY($1::uuid[])`
const DELETE_SQL = `DELETE FROM broker_blocks WHERE id = ANY($1::uuid[]) RETURNING id`
const ACTIVE_SQL = `SELECT count(*)::int AS n FROM broker_blocks WHERE blocked_until > now()`

async function main() {
  const { rows } = await pool.query(SELECT_SQL, [ids])
  console.log('\n── Blocks matched ──')
  for (const r of rows) console.log(' ', JSON.stringify(r))
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id))
    console.error(`\nmissing: ${ids.filter((id) => !found.has(id)).join(', ')} — nothing deleted`)
    process.exitCode = 1
    return
  }

  if (!CONFIRM) {
    console.log('\nDry run. Re-run with --confirm to delete.')
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const del = await client.query(DELETE_SQL, [ids])
    if (del.rowCount !== ids.length) {
      await client.query('ROLLBACK')
      console.error(`expected ${ids.length} rows, deleted ${del.rowCount} — rolled back`)
      process.exitCode = 1
      return
    }
    await client.query('COMMIT')
    console.log(`\nDeleted ${del.rowCount} block(s).`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  const active = await pool.query(ACTIVE_SQL)
  console.log(`Active blocks remaining: ${active.rows[0].n}`)
}

main()
  .catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())

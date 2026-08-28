// PostgreSQL connection pool. This file only manages the connection itself —
// no SQL lives here; queries and schema live in migrations and models.

import { Pool } from 'pg'
import config from '../config.js'

export const pool = new Pool({ connectionString: config.databaseUrl })

// A pooled client can emit an 'error' event on an idle connection when the
// backing connection is lost unexpectedly (network blip, server restart).
// Without this handler, that error would crash the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err)
})

export async function query(text, params) {
  return pool.query(text, params)
}

// Runs `fn` against a single checked-out client wrapped in a transaction:
// BEGIN → fn(client) → COMMIT, with ROLLBACK on any failure and the client
// always released back to the pool afterward.
//
// `BEGIN`/`COMMIT`/`ROLLBACK` here are connection/transaction control, not
// business SQL against any table — they don't touch `users` or any other
// domain table, so this does not violate the "only users.repository.js
// writes SQL against `users`" rule. Callers pass their own repository
// functions a `client` and those functions still own every actual `users`
// query; this helper only brackets the transaction around them.
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

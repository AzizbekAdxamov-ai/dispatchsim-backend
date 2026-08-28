// PostgreSQL connection pool. This file only manages the connection itself —
// no SQL lives here; queries and schema live in migrations and models.

import { Pool } from 'pg'
import config from '../config.js'

// A local dev database speaks plain TCP; every managed provider requires TLS.
// Wrapped in try/catch because a password with an unescaped special character
// makes `new URL` throw, and an unhandled throw here would crash the process
// at import time with an error that points nowhere near the real cause.
function dbHostname() {
  try {
    return new URL(config.databaseUrl).hostname
  } catch {
    return ''
  }
}
const isLocalDb = /^(localhost|127\.0\.0\.1)$/.test(dbHostname())

// Certificate verification stays ON. Neon, Supabase and RDS all present
// certificates that chain to a public CA, so verification succeeds without
// any extra trust configuration -- turning it off would silently accept a
// man-in-the-middle. PG_SSL_NO_VERIFY exists only as a deliberate, explicit
// escape hatch for a provider with a genuinely private CA; it is never the
// fix for a connection that "just won't connect".
const sslNoVerify = process.env.PG_SSL_NO_VERIFY === '1'

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: !sslNoVerify },
  // On Vercel each request can land on its own serverless instance, each
  // holding its own pool — a large per-instance max would multiply into far
  // more upstream connections than Neon's pooler endpoint should take from
  // one app. Kept low here; local dev (one process, one pool) doesn't need it.
  max: isLocalDb ? 10 : 3,
})

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

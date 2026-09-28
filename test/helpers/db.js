// Is there a database to test against, really?
//
// Every DB-backed test used to ask `Boolean(process.env.DATABASE_URL)`.
// That is not the question. The URL is in .env on every machine, so the
// guard always said yes -- and on a machine with no server listening
// (the cloud VM an assistant works in, CI without a service container)
// eleven tests did not skip, they FAILED with ECONNREFUSED.
//
// A suite that is normally eleven-red teaches everyone to read `# fail`
// and shrug, which is how the alert that could never fire and the tests
// that wrote to the real database both survived review. A skip says "not
// checked here"; a failure must keep meaning "this is broken".
//
// So the question is asked of the server, once, at import: one connection,
// opened and released. Anything that goes wrong -- refused, wrong
// password, no such database -- is "no database here", because none of
// those is a thing a unit test should try to work around.

import 'dotenv/config'

async function probe() {
  if (!process.env.DATABASE_URL) return false
  try {
    const { pool } = await import('../../src/db/pool.js')
    const client = await pool.connect()
    client.release()
    return true
  } catch {
    return false
  }
}

// Top-level await: node:test collects the file before running it, so the
// answer is known by the time `{ skip: !hasDb }` is evaluated.
export const hasDb = await probe()

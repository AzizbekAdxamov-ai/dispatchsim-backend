// Run fn(client) inside a transaction that is ALWAYS rolled back.
//
// db/pool.js's withTransaction COMMITs when fn succeeds -- it is the
// production helper. Two schema-backed tests used it believing it rolled
// back ("inside the rolled-back transaction"), and every passing `npm test`
// committed their fixtures into the real company: unpaid driver
// settlements marked paid with no cash leaving the ledger, a driver's
// clock set to 600 minutes, a live load's duty plan cut and a breakdown
// wait written onto it. A test that changes the data it runs against is
// silently wrong in the worst way -- it passes.
export async function inRollback(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

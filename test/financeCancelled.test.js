// A cancelled load (migration 072) was never worked: it is not an invoice
// (not even a draft) and its rate is not revenue. Database-backed tests run
// in a rollback; the source checks run without a database.
// Every test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

const { hasDb } = await import('./helpers/db.js')

async function withLoadBeforeAndAfterCancel(fn) {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { makeCheckFixture } = await import('./helpers/dispatchFixture.js')
  const loadsRepo = await import('../src/modules/loads/loads.repository.js')
  await inRollback(pool, async (client) => {
    const fx = await makeCheckFixture(client)
    const cancel = () => loadsRepo.cancelLoad(client, { loadId: fx.loadId, reason: 'carrier_cancelled' })
    await fn({ client, fx, cancel })
  })
}

// Kills: removing `WHERE l.status <> 'cancelled'` from INVOICE_CTE's invoice_base.
test('a cancelled load is not an invoice and not a draft', { skip: !hasDb }, async () => {
  const { INVOICE_CTE } = await import('../src/modules/finance/finance.repository.js')
  await withLoadBeforeAndAfterCancel(async ({ client, fx, cancel }) => {
    const sql = `${INVOICE_CTE}
      SELECT count(*) FILTER (WHERE "loadId" = $1)::int AS mine,
             count(*) FILTER (WHERE status = 'draft')::int AS drafts
        FROM invoice_status`
    const before = (await client.query(sql, [fx.loadId])).rows[0]
    assert.equal(before.mine, 1, 'an undelivered load is a draft invoice')

    await cancel()
    const after = (await client.query(sql, [fx.loadId])).rows[0]
    assert.equal(after.mine, 0)
    assert.equal(after.drafts, before.drafts - 1)
  })
})

// Kills: removing `WHERE l.status <> 'cancelled'` from PROFITABILITY_SQL.
test('a cancelled load is not in the profitability rows', { skip: !hasDb }, async () => {
  const { PROFITABILITY_SQL } = await import('../src/modules/finance/finance.repository.js')
  await withLoadBeforeAndAfterCancel(async ({ client, fx, cancel }) => {
    const ids = async () => (await client.query(PROFITABILITY_SQL)).rows.map((r) => r.loadId)
    assert.ok((await ids()).includes(fx.loadId))
    await cancel()
    assert.ok(!(await ids()).includes(fx.loadId))
  })
})

// Kills: dropping the cancelled filter from either finance query (runs
// with no database).
test('both finance load queries exclude cancelled loads (source)', async () => {
  const { INVOICE_CTE, PROFITABILITY_SQL } = await import('../src/modules/finance/finance.repository.js')
  assert.match(INVOICE_CTE, /l\.status <> 'cancelled'/)
  assert.match(PROFITABILITY_SQL, /l\.status <> 'cancelled'/)
})

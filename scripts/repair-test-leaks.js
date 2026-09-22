// Undo what the committing tests wrote (see check-test-leaks.js).
//
//   node scripts/repair-test-leaks.js            -- shows what it would do
//   node scripts/repair-test-leaks.js --apply    -- does it, in one transaction
//
// A settlement the test marked paid had no money leave the ledger: the
// driver was never paid. The repair is to make it unpaid again (paid_at =
// NULL), so the next payroll run pays it the normal way -- ledger entry
// and all. Only rows that match check-test-leaks.js's definition AND were
// marked paid on or after 2026-09-21 (when the committing tests landed)
// are touched; nothing older, and no ledger row is written by hand.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const SINCE = '2026-09-21T00:00:00Z'
const apply = process.argv.includes('--apply')

const CANDIDATES = `
  SELECT s.id, s.driver_id AS "driverId", s.load_id AS "loadId", s.net_usd AS "netUsd", s.paid_at AS "paidAt"
    FROM driver_settlements s
   WHERE s.paid_at IS NOT NULL AND s.paid_at >= $1
     AND NOT EXISTS (
       SELECT 1 FROM cash_ledger c
        WHERE c.kind = 'settlement' AND c.ref_type = 'settlement' AND c.ref_id = s.id::text)
   ORDER BY s.id
   FOR UPDATE`

const client = await pool.connect()
try {
  await client.query('BEGIN')
  const rows = (await client.query(CANDIDATES, [SINCE])).rows
  console.log(`${rows.length} settlement(s) marked paid with no payment since ${SINCE}:`)
  for (const r of rows) console.log(`  #${r.id}  driver ${r.driverId}  load ${r.loadId}  $${r.netUsd}  paid_at ${r.paidAt.toISOString()}`)
  if (!apply) {
    await client.query('ROLLBACK')
    console.log(rows.length ? 'Dry run. Re-run with --apply to mark them unpaid.' : 'Nothing to do.')
  } else {
    const ids = rows.map((r) => r.id)
    const done = ids.length
      ? await client.query(`UPDATE driver_settlements SET paid_at = NULL WHERE id = ANY($1::bigint[]) AND paid_at IS NOT NULL RETURNING id`, [ids])
      : { rows: [] }
    await client.query('COMMIT')
    console.log(`Marked unpaid: ${done.rows.map((r) => '#' + r.id).join(', ') || 'none'}. The next payroll run pays them through the ledger.`)
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(`Repair failed, nothing changed: ${err.message}`)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

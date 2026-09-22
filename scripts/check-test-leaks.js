// Did `npm test` write into the company? Read-only -- changes nothing.
//
//   node scripts/check-test-leaks.js
//
// Until 2026-09-22 two schema-backed tests (availability.test.js,
// openEventLog.test.js) ran their fixtures through db/pool.js's
// withTransaction, which COMMITS on success. Every passing run:
//   1. marked every unpaid settlement of the first driver as paid --
//      paid_at set, but no 'settlement' row in cash_ledger (no money left);
//   2. set that driver to resting with hos_remaining_min = 600 (the tick's
//      syncDriverHos rewrites this on its own -- nothing to repair);
//   3. cut the newest dispatched load's duty plan and wrote a breakdown
//      wait onto it, with an EVENT_WAIT_LOGGED fact, with no load_events
//      row behind it.
// This lists what 1 and 3 left behind, so the decision to repair (and
// how) is made on facts.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const PAID_WITHOUT_MONEY = `
  SELECT s.id, s.driver_id AS "driverId", s.load_id AS "loadId", s.net_usd AS "netUsd", s.paid_at AS "paidAt"
    FROM driver_settlements s
   WHERE s.paid_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM cash_ledger c
        WHERE c.kind = 'settlement' AND c.ref_type = 'settlement' AND c.ref_id = s.id::text)
   ORDER BY s.paid_at`

const WAITS_WITHOUT_EVENT = `
  SELECT e.id, e.load_id AS "loadId", e.driver_id AS "driverId", e.status, e.started_at AS "startedAt"
    FROM duty_events e
   WHERE e.origin = 'automatic' AND e.load_id IS NOT NULL
     AND e.status = 'on-duty-not-driving' AND e.facility_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM load_events le
        WHERE le.load_id = e.load_id AND le.occurred_at = e.started_at)
     AND EXISTS (
       SELECT 1 FROM loads l
        WHERE l.id = e.load_id
          AND l.stop_plan_facts @> '[{"code":"EVENT_WAIT_LOGGED"}]'::jsonb)
   ORDER BY e.started_at`

try {
  const paid = (await pool.query(PAID_WITHOUT_MONEY)).rows
  const waits = (await pool.query(WAITS_WITHOUT_EVENT)).rows
  console.log(`Settlements marked paid with no cash_ledger payment: ${paid.length}`)
  for (const r of paid) console.log(`  #${r.id}  driver ${r.driverId}  load ${r.loadId}  $${r.netUsd}  paid_at ${r.paidAt.toISOString()}`)
  console.log(`Breakdown waits on the log with no road event behind them: ${waits.length}`)
  for (const r of waits) console.log(`  duty_event #${r.id}  load ${r.loadId}  driver ${r.driverId}  ${r.startedAt.toISOString()}`)
  if (paid.length === 0 && waits.length === 0) console.log('Nothing leaked.')
} finally {
  await pool.end()
}

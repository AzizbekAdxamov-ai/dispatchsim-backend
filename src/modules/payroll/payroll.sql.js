// Every SQL string the payroll module runs.
//
// Same arrangement as alerts.sql.js and for the same reason:
// scripts/sql-check.js PREPAREs every export it finds here, so a query
// added to this file is parsed against the real schema without anyone
// remembering to register it. Interpolations are constants, never input.

import { FINANCE_REAL_SEC_PER_SIM_DAY } from '../../constants/simClock.js'

// Earn a settlement at delivery.
//
// ON CONFLICT DO NOTHING against settlement_one_per_load is the whole
// idempotency story: the tick runs every 30 seconds and retries after a
// failure, and this makes a second attempt a no-op rather than a second
// week's pay. Nothing has to remember to check first.
export const CREATE_SETTLEMENT_SQL = `
  INSERT INTO driver_settlements (
    driver_id, load_id, gross_usd, deductions_usd, net_usd, due_at
  ) VALUES (
    $1, $2, $3, $4, $5, now() + ($6::int * interval '1 second')
  )
  ON CONFLICT (load_id) DO NOTHING
  RETURNING id, driver_id AS "driverId", load_id AS "loadId",
            net_usd AS "netUsd", due_at AS "dueAt"`

// What payroll would pay right now: everything owed and past its due date,
// oldest first, so the person who has waited longest is paid first rather
// than whoever happens to sort near the top.
//
// FOR UPDATE SKIP LOCKED because a payroll run and the tick can overlap.
export const CLAIM_DUE_SETTLEMENTS_SQL = `
  SELECT s.id, s.driver_id AS "driverId", s.load_id AS "loadId",
         s.net_usd AS "netUsd", s.due_at AS "dueAt",
         d.name AS "driverName"
    FROM driver_settlements s
    JOIN drivers d ON d.id = s.driver_id
   WHERE s.paid_at IS NULL AND s.due_at <= now()
     AND ($2::text IS NULL OR s.driver_id = $2)
   ORDER BY s.due_at, s.id
   LIMIT $1
   FOR UPDATE OF s SKIP LOCKED`

// Pay one. The WHERE clause is the second half of "cannot pay twice": the
// first is cash_ledger_once_per_ref on (kind, ref_type, ref_id). Zero rows
// back means somebody else already paid it and no money should move.
export const MARK_SETTLEMENT_PAID_SQL = `
  UPDATE driver_settlements
     SET paid_at = now()
   WHERE id = $1 AND paid_at IS NULL
   RETURNING id, driver_id AS "driverId", load_id AS "loadId", net_usd AS "netUsd"`

// The Settlements page. One row per settlement, from the table that holds
// the money that actually moved -- not recomputed from a second formula on
// a second calendar, which is what this replaced.
export const LIST_SETTLEMENTS_SQL = `
  SELECT s.id, s.driver_id AS "driverId", d.name AS "driverName",
         s.load_id AS "loadId", l.distance_mi AS "distanceMi",
         l.origin_city AS "originCity", l.origin_state AS "originState",
         l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
         d.pay_model AS "payModel", d.pay_percent_bp AS "payPercentBp",
         d.pay_per_mile_cents AS "payPerMileCents",
         s.gross_usd AS "grossUsd", s.deductions_usd AS "deductionsUsd",
         s.net_usd AS "netUsd",
         s.earned_at AS "earnedAt", s.due_at AS "dueAt", s.paid_at AS "paidAt",
         CASE WHEN s.paid_at IS NOT NULL THEN 'paid'
              WHEN now() > s.due_at THEN 'overdue'
              ELSE 'accrued'
         END AS status,
         CASE WHEN s.paid_at IS NOT NULL THEN 0
              ELSE GREATEST(0, floor(
                EXTRACT(EPOCH FROM (now() - s.due_at)) / ${FINANCE_REAL_SEC_PER_SIM_DAY}
              ))::int
         END AS "daysOverdue"
    FROM driver_settlements s
    JOIN drivers d ON d.id = s.driver_id
    JOIN loads   l ON l.id = s.load_id
   ORDER BY s.paid_at NULLS FIRST, s.due_at, s.id`

// What every driver is owed, and -- the number that decides whether they
// will work -- how overdue their OLDEST unpaid settlement is.
//
// The oldest, not the total. Someone owed $200 for three weeks has a
// sharper grievance than someone owed $4,000 since yesterday, and it is
// the waiting that makes a person leave.
export const DRIVER_OWED_SQL = `
  SELECT d.id AS "driverId", d.name AS "driverName",
         count(s.id) FILTER (WHERE s.paid_at IS NULL)::int AS "unpaidCount",
         coalesce(sum(s.net_usd) FILTER (WHERE s.paid_at IS NULL), 0)::int AS "owedUsd",
         min(s.due_at) FILTER (WHERE s.paid_at IS NULL) AS "oldestDueAt",
         -- NULL when nothing is owed, and the CASE is what guarantees it.
         -- GREATEST ignores NULLs in PostgreSQL, so GREATEST(0, NULL) is 0,
         -- not NULL: without this every driver who owes nothing would come
         -- back "0 days overdue" and stageFor() would read that as a driver
         -- with a grievance. Owing nothing and being owed since this
         -- instant are not the same state.
         CASE WHEN count(s.id) FILTER (WHERE s.paid_at IS NULL) = 0 THEN NULL
              ELSE GREATEST(0, floor(
                EXTRACT(EPOCH FROM (
                  now() - min(s.due_at) FILTER (WHERE s.paid_at IS NULL)
                )) / ${FINANCE_REAL_SEC_PER_SIM_DAY}
              ))::int
         END AS "daysOverdue"
    FROM drivers d
    LEFT JOIN driver_settlements s ON s.driver_id = d.id
   GROUP BY d.id, d.name
   ORDER BY "daysOverdue" DESC NULLS LAST, d.name`

// The same figure for one driver, asked at the moment of dispatch.
export const DRIVER_OWED_ONE_SQL = `
  SELECT d.id AS "driverId", d.name AS "driverName",
         count(s.id) FILTER (WHERE s.paid_at IS NULL)::int AS "unpaidCount",
         coalesce(sum(s.net_usd) FILTER (WHERE s.paid_at IS NULL), 0)::int AS "owedUsd",
         min(s.due_at) FILTER (WHERE s.paid_at IS NULL) AS "oldestDueAt",
         -- NULL when nothing is owed, and the CASE is what guarantees it.
         -- GREATEST ignores NULLs in PostgreSQL, so GREATEST(0, NULL) is 0,
         -- not NULL: without this every driver who owes nothing would come
         -- back "0 days overdue" and stageFor() would read that as a driver
         -- with a grievance. Owing nothing and being owed since this
         -- instant are not the same state.
         CASE WHEN count(s.id) FILTER (WHERE s.paid_at IS NULL) = 0 THEN NULL
              ELSE GREATEST(0, floor(
                EXTRACT(EPOCH FROM (
                  now() - min(s.due_at) FILTER (WHERE s.paid_at IS NULL)
                )) / ${FINANCE_REAL_SEC_PER_SIM_DAY}
              ))::int
         END AS "daysOverdue"
    FROM drivers d
    LEFT JOIN driver_settlements s ON s.driver_id = d.id
   WHERE d.id = $1
   GROUP BY d.id, d.name`

// The company clock stopped while nobody was running it: push every unpaid
// settlement's due date forward by the real seconds the gap dropped, so a
// settlement ages only through time the company actually lived. Paid rows
// are history and stay exactly as they were.
export const HOLD_SETTLEMENT_CLOCK_SQL = `
  UPDATE driver_settlements
     SET due_at = due_at + ($1::int * interval '1 second')
   WHERE paid_at IS NULL`

// The tick's own watermark for the above. A key of its own rather than the
// interest one: interest's stands still under FINANCE=off, and a gap
// measured from a stale watermark would shift pay for time the server was
// up. DO NOTHING + FOR UPDATE is the whole concurrency story: the first
// tick in creates the row, and every tick after it queues on the row lock
// and reads the watermark the previous one left.
export const ENSURE_TICK_CLOCK_SQL = `
  INSERT INTO sim_state (key, value, updated_at)
  VALUES ('tick_clock', jsonb_build_object('lastAt', $1::text), now())
  ON CONFLICT (key) DO NOTHING`

export const READ_TICK_CLOCK_SQL = `
  SELECT value->>'lastAt' AS "lastAt" FROM sim_state
   WHERE key = 'tick_clock' FOR UPDATE`

export const WRITE_TICK_CLOCK_SQL = `
  UPDATE sim_state
     SET value = jsonb_build_object('lastAt', $1::text), updated_at = now()
   WHERE key = 'tick_clock'`

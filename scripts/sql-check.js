// Parse-check the hand-written SQL that no test exercises.
//
//   node scripts/sql-check.js
//
// PREPARE makes PostgreSQL parse and plan a statement against the real
// schema without running it: a typo, a wrong column name, or an illegal
// CTE fails here instead of at 2am in a chat window. Everything happens
// inside a transaction that is rolled back, so no row is touched and no
// prepared statement survives.
//
// This exists because replacePendingReply's data-modifying CTE cannot be
// checked by `node --check` -- to Node it is just a string.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
// Exported so this file checks the SAME string finance.repository.js runs.
// A copy pasted here would pass forever while the original drifted.
import { INVOICE_CTE } from '../src/modules/finance/finance.repository.js'
import { DASHBOARD_COUNTS_SQL } from '../src/modules/loads/loads.repository.js'
// Every export of alerts.sql.js is a statement, and every one of them is
// checked -- see the loop below. A query added to that module is parsed
// against the real schema without anyone having to register it here.
import * as alertSql from '../src/modules/alerts/alerts.sql.js'
import * as payrollSql from '../src/modules/payroll/payroll.sql.js'
import * as driverChatSql from '../src/modules/driverChat/driverChat.sql.js'
import * as loadEventsSql from '../src/modules/loadEvents/loadEvents.sql.js'
import * as fleetSql from '../src/modules/fleet/fleet.sql.js'
import * as trackingSql from '../src/modules/tracking/tracking.repository.js'
import * as documentsSql from '../src/modules/documents/documents.sql.js'
import * as solvencySql from '../src/modules/cash/solvency.sql.js'
// reset-company.js cannot be imported -- it wipes on load -- so the query
// it depends on lives in a module that can be.
import * as chatBudgetSql from '../src/modules/chat/chatBudget.sql.js'
import * as routingSql from '../src/modules/routing/routing.sql.js'
import * as facilitiesSql from '../src/modules/facilities/facilities.sql.js'
import * as stopVisitsSql from '../src/modules/facilities/stopVisits.sql.js'
import * as dutyEventsSql from '../src/modules/hos/dutyEvents.sql.js'
import * as dvirSql from '../src/modules/fleet/dvir.sql.js'
import * as preTripSql from '../src/modules/fleet/preTrip.sql.js'
import * as botSql from '../src/bot/bot.sql.js'
import * as complianceSql from '../src/modules/compliance/compliance.sql.js'
// The board's search is assembled from a dozen optional pieces, so there
// is no string to copy here -- the builders are imported and asked for the
// exact statements the module runs. test/loadBoardSearch.test.js checks
// how they are built; this checks that PostgreSQL accepts the result.
import { buildListPostingsSql, buildCountPostingsSql } from '../src/modules/loadBoard/loadBoard.repository.js'
import * as carrierSql from '../src/modules/carrier/carrier.sql.js'
import { REACHABLE_SQL } from '../src/db/companyTables.js'
import { TRUCK_OPTIONS_SQL } from '../src/modules/drivers/drivers.repository.js'
// fresh-start.js deletes on import for the same reason reset-company.js
// does, so its statements live in a module. These are the ones that run
// against a live company database with nothing to undo them -- the last
// place a wrong column name should be discovered is halfway through.
import { RELEASE as FRESH_RELEASE, WIPE as FRESH_WIPE, RESET_KEPT_DRIVER } from '../src/db/freshStart.sql.js'

const STATEMENTS = [
  ['replacePendingReply', `
    WITH pending AS (
      SELECT id, deliver_at FROM broker_messages
       WHERE conversation_id = $1 AND role = 'broker'
         AND kind = 'text' AND deliver_at > now()
    ),
    slot AS (SELECT min(deliver_at) AS deliver_at FROM pending),
    del AS (DELETE FROM broker_messages WHERE id IN (SELECT id FROM pending))
    INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
    SELECT $1, 'broker', $2, 'text', slot.deliver_at
      FROM slot WHERE slot.deliver_at IS NOT NULL
    RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`],

  ['listMessages (delivered only)', `
    SELECT id, role, content, kind, created_at AS "createdAt"
      FROM broker_messages
     WHERE conversation_id = $1 AND deliver_at <= now()
     ORDER BY deliver_at ASC, created_at ASC, id ASC`],

  ['addMessage (delayed)', `
    INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
    VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
    RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`],

  ['setRateCon', `
    UPDATE broker_conversations
       SET rate_con_rate_usd = $2, updated_at = now()
     WHERE id = $1 AND status = 'agreed'
     RETURNING id, rate_con_rate_usd`],

  ['markBooked', `
    UPDATE broker_conversations
       SET status = 'booked', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'agreed'
       AND rate_con_rate_usd IS NOT NULL
     RETURNING id, status`],

  ['clearRateCon (delete)', `
    DELETE FROM broker_messages WHERE conversation_id = $1 AND kind = 'rate_con'`],

  ['rateConDelivered', `
    SELECT EXISTS (
      SELECT 1 FROM broker_messages
       WHERE conversation_id = $1 AND kind = 'rate_con' AND deliver_at <= now()
    ) AS delivered`],

  ['hasPendingReply', `
    SELECT EXISTS (
      SELECT 1 FROM broker_messages
       WHERE conversation_id = $1 AND deliver_at > now()
    ) AS pending`],

  ['getAgreedRate (paper first)', `
    SELECT coalesce(rate_con_rate_usd, agreed_rate_usd) AS rate
      FROM broker_conversations
     WHERE posting_id = $1 AND user_id = $2 AND status IN ('agreed', 'booked')`],

  ['findBrokerByMc', `
    SELECT id, name, contact_name AS "contactName", mc_number AS "mcNumber",
           credit_rating AS "creditRating", days_to_pay AS "daysToPay"
      FROM brokers
     WHERE upper(regexp_replace(mc_number, '^[Mm][Cc][^0-9]*', '')) =
           upper(regexp_replace($1,        '^[Mm][Cc][^0-9]*', ''))`],

  ['recordCheck', `
    INSERT INTO broker_checks (user_id, mc_number, broker_id, credit_rating, days_to_pay)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, mc_number AS "mcNumber", broker_id AS "brokerId",
              credit_rating AS "creditRating", days_to_pay AS "daysToPay",
              checked_at AS "checkedAt"`],

  ['claimArrivedLoads (with driver pay)', `
    SELECT l.id, l.rate_usd AS "rateUsd", l.distance_mi AS "distanceMi",
           l.payment_terms AS "paymentTerms", l.driver_id AS "driverId", l.broker,
           d.name AS "driverName", d.pay_model AS "payModel",
           d.pay_percent_bp AS "payPercentBp",
           d.pay_per_mile_cents AS "payPerMileCents"
      FROM loads l
      LEFT JOIN drivers d ON d.id = l.driver_id
     WHERE l.delivered_at IS NULL AND l.eta_at IS NOT NULL AND l.eta_at <= now()
       AND l.status <> 'done'
     ORDER BY l.eta_at
     LIMIT $1
     FOR UPDATE OF l SKIP LOCKED`],

  ['markLate', `
    UPDATE loads
       SET status = CASE WHEN now() > delivery_at THEN 'crit' ELSE 'warn' END
     WHERE delivered_at IS NULL
       AND status IN ('ontime', 'warn')
       AND (now() > delivery_at OR eta_at > delivery_at)
       AND status <> CASE WHEN now() > delivery_at THEN 'crit' ELSE 'warn' END
     RETURNING id, status`],

  ['cancelDispatch', `
    UPDATE loads
       SET status = 'neutral', driver_id = NULL, truck_id = NULL,
           dispatched_at = NULL, eta_at = NULL
     WHERE id = $1 AND delivered_at IS NULL
       AND status IN ('ontime', 'warn', 'crit')
     RETURNING id, driver_id AS "driverId"`],

  ['sim_state: read insurance', `
    SELECT value FROM sim_state WHERE key = 'insurance' FOR UPDATE`],

  ['countInsurableTrucks', `SELECT count(*)::int AS n FROM trucks`],

  ['finance dueAt (compressed calendar)', `
    SELECT coalesce(l.invoice_due_at,
             l.delivered_at + interval '30 days') AS "dueAt"
      FROM loads l`],

  ['sim_state: read interest', `
    SELECT value FROM sim_state WHERE key = 'interest' FOR UPDATE`],

  ['sim_state: write interest', `
    INSERT INTO sim_state (key, value, updated_at)
    VALUES ('interest', jsonb_build_object('lastAt', $1::text, 'accruedUsd', $2::numeric), now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`],

  ['claimDueInvoices (with accessorials)', `
    SELECT id, rate_usd AS "rateUsd", broker, payment_terms AS "paymentTerms",
           coalesce((SELECT sum((a->>'amountUsd')::int)
                       FROM jsonb_array_elements(accessorials) a), 0)::int
             AS "accessorialsUsd"
      FROM loads
     WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL
       AND invoice_due_at IS NOT NULL AND invoice_due_at <= now()
     ORDER BY invoice_due_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`],

  ['releaseDriver', `
    UPDATE drivers SET duty_status = 'resting' WHERE id = $1`],

  ['appendStopPlanFacts', `
    UPDATE loads
       SET stop_plan_facts = stop_plan_facts || $2::jsonb, stop_plan_at = now()
     WHERE id = $1
    RETURNING id`],

  ['setStopPlanOutcome', `
    UPDATE loads
       SET stop_plan_status = $2, stop_plan_facts = $3::jsonb, stop_plan_at = now()
     WHERE id = $1
    RETURNING id`],

  ['driver availability (real statuses)', `
    SELECT count(*)::int FROM loads l
     WHERE l.driver_id = $1 AND l.status IN ('ontime','warn','crit')`],

  ['cash: balance', `SELECT coalesce(sum(amount_usd), 0)::int AS balance FROM cash_ledger`],

  ['cash: summary', `
    SELECT
      coalesce(sum(amount_usd), 0)::int                                AS balance,
      coalesce(sum(amount_usd) FILTER (WHERE amount_usd > 0), 0)::int  AS "totalIn",
      coalesce(sum(amount_usd) FILTER (WHERE amount_usd < 0), 0)::int  AS "totalOut",
      count(*)::int                                                    AS entries
    FROM cash_ledger`],

  ['cash: receivables', `
    SELECT
      coalesce(sum(rate_usd), 0)::int                                        AS "outstandingUsd",
      count(*)::int                                                          AS "openInvoices",
      coalesce(sum(rate_usd) FILTER (WHERE invoice_due_at <= now()), 0)::int AS "overdueUsd"
    FROM loads
    WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL`],

  ['cash: addEntry', `
    INSERT INTO cash_ledger (kind, amount_usd, description, ref_type, ref_id, created_by, occurred_at)
    VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
    RETURNING id, occurred_at AS "occurredAt", kind, amount_usd AS "amountUsd",
              description, ref_type AS "refType", ref_id AS "refId"`],

  ['cash: listEntries', `
    SELECT id, occurred_at AS "occurredAt", kind, amount_usd AS "amountUsd",
           description, ref_type AS "refType", ref_id AS "refId"
      FROM cash_ledger
     WHERE ($2::text IS NULL OR kind = $2)
     ORDER BY occurred_at DESC, id DESC
     LIMIT $1`],

  ['dispatchLoad', `
    UPDATE loads
       SET status = 'ontime', driver_id = $2, truck_id = $3,
           dispatched_at = now(),
           eta_at = now() + ($4::int * interval '1 second')
     WHERE id = $1 AND status = 'neutral'
     RETURNING id, eta_at AS "etaAt", distance_mi AS "distanceMi", rate_usd AS "rateUsd"`],

  ['getDriverForDispatch', `
    SELECT d.id, d.name, d.hos_remaining_min AS "hosRemainingMin",
           t.id AS "truckId",
           (SELECT count(*) FROM loads l
             WHERE l.driver_id = d.id AND l.status <> 'done')::int AS "activeLoads"
      FROM drivers d
      LEFT JOIN trucks t ON t.driver_id = d.id
     WHERE d.id = $1`],

  ['claimArrivedLoads', `
    SELECT id, rate_usd AS "rateUsd", distance_mi AS "distanceMi",
           payment_terms AS "paymentTerms", driver_id AS "driverId", broker
      FROM loads
     WHERE delivered_at IS NULL AND eta_at IS NOT NULL AND eta_at <= now()
       AND status <> 'done'
     ORDER BY eta_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`],

  ['markDelivered', `
    UPDATE loads
       SET status = 'done', delivered_at = now(),
           invoice_due_at = now() + ($2::int * interval '1 second')
     WHERE id = $1 AND delivered_at IS NULL
     RETURNING id, delivered_at AS "deliveredAt", invoice_due_at AS "invoiceDueAt"`],

  ['claimDueInvoices', `
    SELECT id, rate_usd AS "rateUsd", broker, payment_terms AS "paymentTerms"
      FROM loads
     WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL
       AND invoice_due_at IS NOT NULL AND invoice_due_at <= now()
     ORDER BY invoice_due_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`],

  ['markInvoicePaid', `
    UPDATE loads SET invoice_paid_at = now()
     WHERE id = $1 AND invoice_paid_at IS NULL
     RETURNING id`],

  ['truck listing columns (spec sheet)', `
    SELECT l.id, l.make, l.model, l.year, l.odometer_mi, l.price_usd,
           l.trailer_type, l.fuel_capacity_gal, l.tire_front_pct,
           l.tire_rear_pct, l.service_notes, l.seller,
           l.vin, l.engine_make, l.engine_model, l.horsepower,
           l.transmission, l.sleeper, l.suspension, l.axle_config,
           l.wheelbase_in, l.front_axle_lbs, l.rear_axle_lbs, l.gvwr_lbs,
           l.has_apu, l.location_city, l.location_state
      FROM truck_listings l WHERE l.id = $1`],

  ['insertTruck (with spec sheet)', `
    INSERT INTO trucks (
      id, make, model, year, odometer_mi, status, trailer_type,
      fuel_capacity_gal, fuel_pct, fuel_gallons, tire_front_pct, tire_rear_pct,
      vin, engine_make, engine_model, horsepower, transmission, sleeper,
      suspension, axle_config, wheelbase_in, front_axle_lbs,
      rear_axle_lbs, gvwr_lbs, has_apu, current_location
    ) VALUES ($1,$2,$3,$4,$5,'idle',$6,$7,50,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    RETURNING id`],

  ['truck columns (spec sheet)', `
    SELECT t.id, t.vin, t.engine_make, t.engine_model, t.horsepower,
           t.transmission, t.sleeper, t.suspension, t.axle_config,
           t.wheelbase_in, t.front_axle_lbs, t.rear_axle_lbs,
           t.gvwr_lbs, t.has_apu
      FROM trucks t WHERE t.id = $1`],

  ['listChecks', `
    SELECT k.id, k.mc_number AS "mcNumber", k.broker_id AS "brokerId",
           k.credit_rating AS "creditRating", k.days_to_pay AS "daysToPay",
           k.checked_at AS "checkedAt",
           b.name AS "brokerName", b.contact_name AS "brokerContactName"
      FROM broker_checks k
      LEFT JOIN brokers b ON b.id = k.broker_id
     WHERE k.user_id = $1
     ORDER BY k.checked_at DESC
     LIMIT $2`],

  // --- promised_eta_at (migration 023). The three statements that decide
  // whether a load can ever be late. The previous lateness fix shipped
  // looking correct and never fired once; nothing here is trusted until
  // PostgreSQL has parsed it against the real schema.
  ['dispatchLoad (eta + promise)', `
    UPDATE loads
       SET status = 'ontime',
           driver_id = $2,
           truck_id = $3,
           dispatched_at = now(),
           promised_eta_at = now() + ($5::int * interval '1 second'),
           eta_at = now() + ($4::int * interval '1 second')
     WHERE id = $1 AND status = 'neutral'
     RETURNING id, eta_at AS "etaAt", promised_eta_at AS "promisedEtaAt",
               distance_mi AS "distanceMi", rate_usd AS "rateUsd"`],

  ['markLate (reveal fraction)', `
    UPDATE loads
       SET status = CASE
             WHEN now() > promised_eta_at THEN 'crit'
             ELSE 'warn'
           END
     WHERE delivered_at IS NULL
       AND promised_eta_at IS NOT NULL
       AND dispatched_at IS NOT NULL
       AND status IN ('ontime', 'warn')
       AND (
             now() > promised_eta_at
             OR (
               eta_at > promised_eta_at
               AND now() >= dispatched_at
                           + (promised_eta_at - dispatched_at) * $1::float8
             )
           )
       AND status <> CASE
             WHEN now() > promised_eta_at THEN 'crit'
             ELSE 'warn'
           END
     RETURNING id, status`],

  ['cancelDispatch (clears promise)', `
    UPDATE loads
       SET status = 'neutral', driver_id = NULL, truck_id = NULL,
           dispatched_at = NULL, eta_at = NULL, promised_eta_at = NULL
     WHERE id = $1 AND delivered_at IS NULL
       AND status IN ('ontime', 'warn', 'crit')
     RETURNING id, driver_id AS "driverId"`],

  // --- The two on-time readings. Both compared the wrong thing and both
  // could only ever return 100%; parsed here so the corrected versions
  // are checked against the real columns.
  ['getDashboardCounts (on-time is a fact)', DASHBOARD_COUNTS_SQL],

  ['getOnTimeTrend (same clock)', `
    SELECT
      date_trunc('day', delivered_at)::date AS day,
      round(100.0 * count(*) FILTER (
        WHERE promised_eta_at IS NULL OR delivered_at <= promised_eta_at
      ) / count(*))::int AS "onTimePct"
    FROM loads
    WHERE delivered_at IS NOT NULL AND delivered_at >= current_date - $1::int
    GROUP BY 1
    ORDER BY 1`],

  // --- The invoice CTE every Finance query builds on. daysPastDue was
  // counted in real calendar days against a compressed-calendar due date
  // and could only ever be 0; the aging buckets and the past-due badge
  // both read it.
  ['INVOICE_CTE (sim-day aging)', `${INVOICE_CTE} SELECT * FROM invoice_status`],

  // (The load board's own statements are built by the module and pushed in
  // below -- migration 030's rate suppression travels with them.)

  ['brokerChat: the broker still knows the rate', `
    SELECT p.rate_usd AS "rateUsd", p.rate_hidden AS "rateHidden"
      FROM load_postings p WHERE p.id = $1`],

  ['refresh: broker relationship history', `
    SELECT broker, count(*)::int AS n FROM loads GROUP BY broker`],

  ['reset: tables reachable from the company', REACHABLE_SQL],
]

// The alerts module registers itself. This is the only block in the file
// that does not name its statements by hand, and it exists because the
// hand-written list is the part that rots: someone adds a query, forgets
// this file, and the checker keeps reporting a clean run it never earned.
for (const [label, mod] of [['alerts', alertSql], ['payroll', payrollSql], ['driverChat', driverChatSql], ['loadEvents', loadEventsSql], ['fleet', fleetSql], ['tracking', trackingSql], ['documents', documentsSql], ['solvency', solvencySql], ['chatBudget', chatBudgetSql], ['routing', routingSql], ['facilities', facilitiesSql], ['stopVisits', stopVisitsSql], ['dutyEvents', dutyEventsSql], ['compliance', complianceSql], ['dvir', dvirSql], ['preTrip', preTripSql], ['telegram', botSql], ['carrier', carrierSql]]) {
  for (const [name, sql] of Object.entries(mod)) {
    if (typeof sql === 'string' && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) {
      STATEMENTS.push([`${label}: ${name}`, sql])
    }
  }
}

// The board's search, as the module builds it. Four combinations, because
// the shape of the statement changes with the filters: the CTE is a
// different one when an origin city is given, DH-D appears only with a
// destination, and the count query moves the radii into a FILTER. A
// renamed column or a mis-numbered placeholder in any of them fails here
// rather than in a chat window.
const BOARD_SEARCHES = [
  ['no filters', {}],
  ['origin point + DH-O radius', { fromCity: 'Dallas', fromState: 'TX', maxDeadheadMi: 150 }],
  ['destination point + DH-D radius', { toCity: 'Atlanta', toState: 'GA', maxDeadheadDestMi: 150 }],
  ['everything at once', {
    fromCity: 'Dallas', fromState: 'TX', toCity: 'Atlanta', toState: 'GA',
    maxDeadheadMi: 150, maxDeadheadDestMi: 150,
    equipmentType: ['reefer', 'dry-van'], originState: 'TX', destinationState: 'GA',
    originZone: 'south-central', destinationZone: 'southeast',
    minRatePerMile: 2, maxLengthFt: 53, maxWeightLbs: 44000,
    pickupFrom: new Date(), pickupBefore: new Date(),
  }],
]

for (const [name, filters] of BOARD_SEARCHES) {
  const full = { sort: 'rate', limit: 25, offset: 0, ...filters }
  STATEMENTS.push([`loadBoard: search -- ${name}`, buildListPostingsSql(full).text])
  STATEMENTS.push([`loadBoard: count -- ${name}`, buildCountPostingsSql(full).text])
}

for (const [name, sql] of FRESH_RELEASE) STATEMENTS.push([`fresh-start: release ${name}`, sql])
for (const [name, sql] of FRESH_WIPE) STATEMENTS.push([`fresh-start: delete ${name}`, sql])
STATEMENTS.push(['fresh-start: reset kept driver', RESET_KEPT_DRIVER])

STATEMENTS.push(['drivers: truck options for a driver', TRUCK_OPTIONS_SQL])

const client = await pool.connect()
let failed = 0

try {
  await client.query('BEGIN')
  let i = 0
  for (const [name, sql] of STATEMENTS) {
    i += 1
    // SAVEPOINT per statement. Without it the first failure aborts the
    // whole transaction and PostgreSQL rejects everything after it with
    // "current transaction is aborted" -- which this script then printed
    // as FAIL, reporting six working queries as broken (2026-09-03). A
    // checker that lies about what it checked is worse than no checker.
    await client.query('SAVEPOINT stmt')
    try {
      await client.query(`PREPARE chk_${i} AS ${sql}`)
      await client.query('RELEASE SAVEPOINT stmt')
      console.log(`  ok    ${name}`)
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT stmt')
      failed += 1
      console.log(`  FAIL  ${name}`)
      console.log(`        ${err.message}`)
      if (err.position) console.log(`        pozitsiya: ${err.position}`)
    }
  }
} finally {
  // Nothing was executed, and the rollback also drops the prepared names.
  await client.query('ROLLBACK')
  client.release()
  await pool.end()
}

console.log(`\n${STATEMENTS.length - failed}/${STATEMENTS.length} muvaffaqiyatli`)
process.exit(failed ? 1 : 0)

// Data-access layer for the `loads` table. This is the ONLY file in the
// codebase that writes SQL selecting FROM/writing INTO `loads` directly —
// every other module (drivers, fleet, finance, stats) that needs a `loads`
// row goes through a function exported here.
//
// Like drivers.repository.js, this file also LEFT JOIN LATERALs against
// `drivers` and `trucks` to attach a compact driver/truck summary to each
// load row in one round trip. That is the same read-only enrichment
// pattern users.repository.js already uses against `user_roles` (see the
// comment at the top of drivers.repository.js for the precedent) — it is
// not a second writer of those tables, and drivers.repository.js /
// trucks.repository.js remain the only files that write SQL touching them.
//
// Rules enforced here, same as users.repository.js:
//   - Never `SELECT *`.
//   - Every value goes through a parameterized placeholder ($1, ...);
//     ILIKE search terms are wrapped with '%...%' in JS and still passed
//     as one bound parameter, never spliced into the query text.
//   - snake_case columns are aliased to camelCase in SQL.
//
// No index is added for the `search` ILIKE below: at ~200 rows a full
// table scan is faster than the planner's overhead of consulting an index,
// and pg_trgm (the only index type that would actually help ILIKE '%...%')
// is not worth the extra extension dependency at this table size. Revisit
// only if `loads` grows by an order of magnitude.

import { query } from '../../db/pool.js'

// Exported for the dispatch board's column queries (loads.service.js):
// one projection, shared, so the board's cards and the list's rows are
// the same shape by construction rather than by promise.
export const LOAD_COLUMNS = `
  l.id, l.origin_city AS "originCity", l.origin_state AS "originState",
  l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
  l.broker, l.commodity,
  l.rate_usd AS "rateUsd", l.distance_mi AS "distanceMi", l.weight_lbs AS "weightLbs",
  l.equipment_type AS "equipmentType", l.equipment_length_ft AS "equipmentLengthFt",
  l.status, l.driver_id AS "driverId", l.truck_id AS "truckId",
  l.booked_at AS "bookedAt", l.pickup_at AS "pickupAt", l.delivery_at AS "deliveryAt",
  l.dispatched_at AS "dispatchedAt", l.eta_at AS "etaAt", l.delivered_at AS "deliveredAt",
  l.stop_plan_status AS "stopPlanStatus", l.stop_plan_facts AS "stopPlanFacts",
  l.promised_eta_at AS "promisedEtaAt",
  l.payment_terms AS "paymentTerms", l.invoice_paid_at AS "invoicePaidAt",
  l.accessorials,
  l.created_at AS "createdAt", l.updated_at AS "updatedAt"
`

// Compact driver/truck summaries embedded per row. Full driver/truck detail
// lives behind GET /drivers/:id and GET /fleet/trucks/:id — this is just
// enough for a load list row or a load detail header to render without a
// second request.
// Exported since the dispatch board: loads.service.js composes its four
// column queries from the SAME projection, so a card can never disagree
// with the list about what a load row carries.
export const DRIVER_TRUCK_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', d.id, 'name', d.name, 'phone', d.phone,
      'cdlClass', d.cdl_class, 'cdlNumber', d.cdl_number,
      'hosRemainingMin', d.hos_remaining_min
    ) AS driver
    FROM drivers d WHERE d.id = l.driver_id
  ) driver_row ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('id', t.id, 'make', t.make, 'model', t.model) AS truck
    FROM trucks t WHERE t.id = l.truck_id
  ) truck_row ON true
`

export const ROW_SELECT = `
  SELECT ${LOAD_COLUMNS}, driver_row.driver AS driver, truck_row.truck AS truck
  FROM loads l
  ${DRIVER_TRUCK_LATERAL}
`

// Shared WHERE builder for listLoads/countLoadStatuses, mirroring
// users.repository.js's buildUserFilter. Deliberately does NOT include
// `status` — status is the tab itself, and meta.counts (built from
// countLoadStatuses) needs one bucket per status computed against the SAME
// equipmentType/search filter, so status can't be baked into the shared
// WHERE or every bucket would collapse to just the current tab.
function buildLoadFilter({ equipmentType, search }) {
  const conditions = []
  const params = []

  if (equipmentType) {
    params.push(equipmentType)
    conditions.push(`l.equipment_type = $${params.length}`)
  }

  if (search) {
    params.push(`%${search}%`)
    const idx = params.length
    conditions.push(`(l.id ILIKE $${idx} OR l.broker ILIKE $${idx} OR l.origin_city ILIKE $${idx} OR l.destination_city ILIKE $${idx})`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { whereClause, params }
}

export async function listLoads({ status, equipmentType, search, limit, offset }) {
  const { whereClause, params } = buildLoadFilter({ equipmentType, search })
  const conditions = whereClause ? [whereClause.replace(/^WHERE /, '')] : []

  if (status) {
    params.push(status)
    conditions.push(`l.status = $${params.length}`)
  }

  const finalWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  params.push(limit)
  const limitIdx = params.length
  params.push(offset)
  const offsetIdx = params.length

  const result = await query(
    `${ROW_SELECT}
     ${finalWhere}
     ORDER BY l.pickup_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  )
  return result.rows
}

export async function getLoadById(id, client = null) {
  const runner = client ?? { query }
  const result = await runner.query(`${ROW_SELECT} WHERE l.id = $1`, [id])
  return result.rows[0] ?? null
}

// meta.counts for the /loads tab strip (all/active/pending/delivered/
// delayed — see Loads.jsx's TABS, which this mirrors exactly). Computed
// against the equipmentType/search filter but NOT the status tab, so every
// tab's badge reflects the same search/equipment scope the user is
// currently looking at. One COUNT(*) FILTER query, same shape as
// users.repository.js's countUsers.
export async function countLoadStatuses({ equipmentType, search }) {
  const { whereClause, params } = buildLoadFilter({ equipmentType, search })
  const result = await query(
    `SELECT
       count(*)::int                                                          AS "all",
       count(*) FILTER (WHERE l.status IN ('ontime','warn','crit'))::int      AS active,
       count(*) FILTER (WHERE l.status = 'neutral')::int                      AS pending,
       count(*) FILTER (WHERE l.status = 'done')::int                        AS delivered,
       count(*) FILTER (WHERE l.status = 'crit')::int                        AS delayed
     FROM loads l
     ${whereClause}`,
    params,
  )
  return result.rows[0]
}

// A driver's most recent loads (both open and delivered), for GET
// /drivers/:id's recentLoads[]. Lives here, not in drivers.repository.js,
// because it is a genuine `loads` LISTING (multiple rows, its own ORDER
// BY/LIMIT) rather than the single-row enrichment lookup that file's
// LATERAL joins do — see the header comment on drivers.repository.js.
export async function listLoadsByDriverId(driverId, { limit = 10 } = {}) {
  const result = await query(
    `${ROW_SELECT}
     WHERE l.driver_id = $1
     ORDER BY l.pickup_at DESC
     LIMIT $2`,
    [driverId, limit],
  )
  return result.rows
}

// Raw counts behind GET /stats/dashboard's `stats{}` — see
// stats.service.js, which turns these into the dashboard's stat tiles
// without this file needing to know a single thing about how they're
// labeled or displayed.
// The dashboard's five counts, as one exported string.
//
// Exported because scripts/late-proof.js runs it inside the same
// transaction as the rows it inserts -- getDashboardCounts() goes through
// the pool and would never see them. A copy pasted into the proof would
// keep passing while this one drifted, which is the failure mode that let
// a broken on-time percentage sit unnoticed for weeks.
export const DASHBOARD_COUNTS_SQL = `
  SELECT
    count(*) FILTER (WHERE status <> 'done')::int                  AS "activeLoads",
    count(*) FILTER (WHERE status IN ('ontime','warn','crit'))::int AS "inTransit",
    count(*) FILTER (WHERE status IN ('warn','crit'))::int          AS "atRisk",
    count(*) FILTER (WHERE status <> 'neutral')::int                AS "evaluatedLoads",
    -- On time is a FACT about the delivery, not the status.
    -- markDelivered sets status='done' for every load, late or not, so
    -- FILTER (status IN ('ontime','done')) counted a load that ran 40%
    -- over as on-time the instant it delivered -- the percentage could
    -- only ever read 100 for finished work. The two timestamps below are
    -- both on the compressed calendar and neither is overwritten, so the
    -- answer stays true for as long as the row exists. promised_eta_at
    -- IS NULL is the pre-migration-023 backfill: those loads had no
    -- promise to miss.
    count(*) FILTER (
      WHERE status = 'ontime'
         OR (status = 'done'
             AND (promised_eta_at IS NULL OR delivered_at <= promised_eta_at))
    )::int AS "onTimeLoads"
  FROM loads`

export async function getDashboardCounts() {
  const result = await query(DASHBOARD_COUNTS_SQL)
  return result.rows[0]
}

// Invoiced amount (rate + accessorials) for loads delivered in the
// trailing 7 days vs the 7 days before that — the dashboard's
// week-over-week revenue tile.
export async function getWeeklyRevenue() {
  const result = await query(
    `SELECT
       coalesce(sum(rate_usd + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
       )) FILTER (WHERE delivered_at >= current_date - 7), 0)::int AS "currentUsd",
       coalesce(sum(rate_usd + (
         SELECT coalesce(sum((a->>'amountUsd')::int), 0) FROM jsonb_array_elements(accessorials) a
       )) FILTER (WHERE delivered_at >= current_date - 14 AND delivered_at < current_date - 7), 0)::int AS "previousUsd"
     FROM loads`,
  )
  return result.rows[0]
}

// Daily on-time-delivery percentage for the trailing `days` calendar days,
// for GET /stats/dashboard's onTimeTrend[]. Only days with at least one
// delivery produce a row (an empty day has nothing to compute a
// percentage of); stats.service.js fills any gap with 0 the same way
// fleet's utilization trend does.
export async function getOnTimeTrend(days = 7) {
  const result = await query(
    `SELECT
       date_trunc('day', delivered_at)::date AS day,
       -- delivery_at is the broker's window on the REAL calendar, hours
       -- away; delivered_at lands minutes after dispatch on the
       -- compressed one. The comparison was therefore true for every row
       -- ever written and this trend has always drawn a flat 100. Same
       -- clock on both sides now.
       round(100.0 * count(*) FILTER (
         WHERE promised_eta_at IS NULL OR delivered_at <= promised_eta_at
       ) / count(*))::int AS "onTimePct"
     FROM loads
     WHERE delivered_at IS NOT NULL AND delivered_at >= current_date - $1::int
     GROUP BY 1
     ORDER BY 1`,
    [days],
  )
  return result.rows
}

// Creates a new load row inside an existing transaction. The `client` must
// be a pg PoolClient obtained from pool.connect() with an active BEGIN.
// Pattern copied from invites.repository.js's redeem(client, code).
// The loadBoard module calls this — loads.repository.js remains the ONLY
// file that INSERTs INTO loads.
export async function createLoad(client, {
  id, originCity, originState, destinationCity, destinationState,
  broker, commodity, rateUsd, distanceMi, weightLbs,
  equipmentType, equipmentLengthFt, driverId, truckId,
  pickupAt, deliveryAt, bookedAt, paymentTerms,
}) {
  const result = await client.query(
    `INSERT INTO loads (
       id, origin_city, origin_state, destination_city, destination_state,
       broker, commodity, rate_usd, distance_mi, weight_lbs,
       equipment_type, equipment_length_ft,
       status, driver_id, truck_id,
       booked_at, pickup_at, delivery_at,
       payment_terms, accessorials
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12,
       $13, $14, $15,
       $16, $17, $18,
       $19, '[]'::jsonb
     )
     RETURNING id`,
    [
      id, originCity, originState, destinationCity, destinationState,
      broker, commodity, rateUsd, distanceMi, weightLbs,
      equipmentType, equipmentLengthFt,
      driverId ? 'ontime' : 'neutral', driverId, truckId,
      bookedAt, pickupAt, deliveryAt,
      // Derived from the broker's stated days-to-pay (constants/paymentTerms.js).
      // Defaults to net30 when the posting has no broker on file.
      paymentTerms || 'net30',
    ],
  )
  return result.rows[0]
}

// ---------------------------------------------------------------------
// Dispatch and delivery (2026-09-03)
// ---------------------------------------------------------------------
// Until now nothing here wrote: /loads was two GETs, so a load created by
// accepting a rate confirmation sat at 'neutral' forever and no money ever
// came back in. These are the writes that let a load finish.

// Claim a load for a driver and truck. Conditional on status = 'neutral'
// so two dispatchers cannot send the same load twice; the caller reads 0
// rows and works out why. eta_at is set on the compressed calendar --
// see src/constants/simClock.js.
// Two timestamps, both on the compressed clock: what was promised, and
// what the road is going to do. They are equal on a run that goes fine.
//
// delivery_at -- the broker's contractual window -- is deliberately NOT
// touched. It is on the real calendar, it is what the rate confirmation
// says, and it is what the dispatcher reads. Comparing it against eta_at
// was the bug migration 023 exists to fix: 11 hours against 6.7 minutes.
export async function dispatchLoad(client, { loadId, driverId, truckId, etaSeconds, promisedSeconds }) {
  const result = await client.query(
    `UPDATE loads
        SET status = 'ontime',
            driver_id = $2,
            truck_id = $3,
            dispatched_at = now(),
            promised_eta_at = now() + ($5::int * interval '1 second'),
            eta_at = now() + ($4::int * interval '1 second')
      WHERE id = $1 AND status = 'neutral'
      RETURNING id, eta_at AS "etaAt", promised_eta_at AS "promisedEtaAt",
                distance_mi AS "distanceMi", rate_usd AS "rateUsd",
                -- dispatched_at plus the lane's own city/state pair --
                -- stop planning (dispatch.service.js's planAndSaveStops,
                -- facilities/stopPlan.js) needs both, read straight off
                -- this same write instead of a second SELECT for a fact
                -- this statement already knows.
                dispatched_at AS "dispatchedAt",
                origin_city AS "originCity", origin_state AS "originState",
                destination_city AS "destinationCity", destination_state AS "destinationState"`,
    [loadId, driverId, truckId, etaSeconds, promisedSeconds],
  )
  return result.rows[0] ?? null
}

// eta_at, moved to what the LAW says the run takes, once stop planning
// (dispatch.service.js's planAndSaveStops, facilities/stopPlan.js) has
// actually worked it out. Two timestamps stay on two different clocks
// here, on purpose: promised_eta_at is NOT touched -- it is the broker's
// own promise, and an event does not renegotiate it (loadEvents.sql.js's
// EXTEND_ETA_SQL makes the identical choice) -- so a legal arrival later
// than the promise is exactly what markLate's own eta_at > promised_eta_at
// branch is for, not a reason to refuse the dispatch.
//
// Runs as its own statement, AFTER dispatchLoad's own transaction has
// already committed (dispatch.service.js's planAndSaveStops runs there
// for the same reason: a stop-planning failure must never roll back a
// dispatch that already succeeded). Guarded the same way EXTEND_ETA_SQL
// is -- not yet delivered, and actually dispatched -- so a load that
// delivered or was cancelled in the gap between those two moments is
// left alone rather than getting a legal ETA against a run that is no
// longer happening. Zero rows back means exactly that: nothing was
// silently overwritten, and the caller's own "dispatched anyway, ETA
// left as before" warning already covers this case.
export async function setLegalEtaAt(client, { loadId, legalArrivalAt }) {
  const result = await client.query(
    `UPDATE loads
        SET eta_at = $2
      WHERE id = $1 AND delivered_at IS NULL AND dispatched_at IS NOT NULL
      RETURNING id, eta_at AS "etaAt"`,
    [loadId, legalArrivalAt],
  )
  return result.rows[0] ?? null
}

// What stop planning concluded, on the load itself -- not only in a
// server log nobody reads (037's header). status is one of 037's
// loads_stop_plan_status values; facts is the hosFacts/warnings list,
// each { code, cfr, detail }: things that are true about this run, never
// a verdict on whoever dispatched it.
export async function setStopPlanOutcome(client, { loadId, status, facts }) {
  const result = await client.query(
    `UPDATE loads
        SET stop_plan_status = $2, stop_plan_facts = $3::jsonb, stop_plan_at = now()
      WHERE id = $1
     RETURNING id`,
    [loadId, status, JSON.stringify(facts ?? [])],
  )
  return result.rows[0] ?? null
}

// Adds facts to what stop planning already said about this load --
// a re-plan after a road event keeps the dispatch-time facts and says
// what changed on top of them.
export async function appendStopPlanFacts(client, { loadId, facts }) {
  const result = await client.query(
    `UPDATE loads
        SET stop_plan_facts = stop_plan_facts || $2::jsonb, stop_plan_at = now()
      WHERE id = $1
     RETURNING id`,
    [loadId, JSON.stringify(facts ?? [])],
  )
  return result.rows[0] ?? null
}

// A driver who can take a load: on the roster, not off duty is fine (they
// come on duty by being dispatched), but not already running something.
// The partial unique index loads_one_active_per_driver is the real guard;
// this is the readable pre-flight that produces a decent error.
export async function getDriverForDispatch(client, driverId) {
  const result = await client.query(
    `SELECT d.id, d.name, d.hos_remaining_min AS "hosRemainingMin",
            t.id AS "truckId",
            (SELECT count(*) FROM loads l
              WHERE l.driver_id = d.id AND l.status <> 'done')::int AS "activeLoads"
       FROM drivers d
       LEFT JOIN trucks t ON t.driver_id = d.id
      WHERE d.id = $1`,
    [driverId],
  )
  return result.rows[0] ?? null
}

// Loads whose ETA has passed and that have not been marked delivered.
// FOR UPDATE SKIP LOCKED so two ticks overlapping never process the same
// load twice -- the second one simply does not see it.
export async function claimArrivedLoads(client, limit = 1) {
  const result = await client.query(
    `SELECT l.id, l.rate_usd AS "rateUsd", l.distance_mi AS "distanceMi",
            l.payment_terms AS "paymentTerms", l.driver_id AS "driverId", l.broker,
            -- The driver's terms travel with the load, so settlement can be
            -- written in the same transaction that delivers it. A driver
            -- paid in a second pass could be paid twice, or not at all.
            d.name AS "driverName", d.pay_model AS "payModel",
            d.pay_percent_bp AS "payPercentBp",
            d.pay_per_mile_cents AS "payPerMileCents",
            -- The truck the run wore down, and the window the run spanned.
            -- dispatched_at/pickup_at/delivery_at feed the sim-day spread;
            -- truck_id can be NULL on a load dispatched before trucks were
            -- linked, and the caller checks for that rather than catching.
            l.truck_id AS "truckId", l.dispatched_at AS "dispatchedAt",
            l.pickup_at AS "pickupAt", l.delivery_at AS "deliveryAt",
            -- Detour miles a resolved event added. They burn fuel, wear
            -- tires and land on the odometer -- but are NOT in
            -- distance_mi, which stays the contracted lane. See
            -- loadEvents.service.js resolve().
            (SELECT coalesce(sum(e.extra_miles), 0)::int FROM load_events e
              WHERE e.load_id = l.id) AS "extraMiles"
       FROM loads l
       LEFT JOIN drivers d ON d.id = l.driver_id
      WHERE l.delivered_at IS NULL AND l.eta_at IS NOT NULL AND l.eta_at <= now()
        AND l.status <> 'done'
        -- A truck sitting on the shoulder waiting for a decision does not
        -- arrive. Without this an unresolved road event would cost nothing
        -- -- the load would deliver on time while the driver was still
        -- reporting a breakdown, and ignoring events would be the winning
        -- strategy.
        AND NOT EXISTS (
              SELECT 1 FROM load_events e
               WHERE e.load_id = l.id AND e.resolved_at IS NULL
            )
      ORDER BY l.eta_at
      LIMIT $1
      -- OF l, not a bare FOR UPDATE: PostgreSQL refuses to lock the
      -- nullable side of an outer join, and the driver join is a LEFT
      -- JOIN because a load can be delivered with no driver on it.
      FOR UPDATE OF l SKIP LOCKED`,
    [limit],
  )
  return result.rows
}

// Mark it delivered and set when the money is due, on the compressed
// calendar. loads_done_iff_time requires status and delivered_at to move
// together, so both are set here or neither is.
export async function markDelivered(client, { loadId, dueSeconds }) {
  const result = await client.query(
    `UPDATE loads
        SET status = 'done',
            delivered_at = now(),
            invoice_due_at = now() + ($2::int * interval '1 second')
      WHERE id = $1 AND delivered_at IS NULL
      RETURNING id, delivered_at AS "deliveredAt", invoice_due_at AS "invoiceDueAt"`,
    [loadId, dueSeconds],
  )
  return result.rows[0] ?? null
}

// Delivered loads whose invoice has come due and is still unpaid.
export async function claimDueInvoices(client, limit = 1) {
  const result = await client.query(
    `SELECT id, rate_usd AS "rateUsd", broker, payment_terms AS "paymentTerms",
            -- Accessorials are billed on the invoice and were never
            -- collected: finance counted them as revenue, the ledger
            -- received only rate_usd. Summed here so the payment matches
            -- what was invoiced.
            coalesce((SELECT sum((a->>'amountUsd')::int)
                        FROM jsonb_array_elements(accessorials) a), 0)::int
              AS "accessorialsUsd"
       FROM loads
      WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL
        AND invoice_due_at IS NOT NULL AND invoice_due_at <= now()
      ORDER BY invoice_due_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
  return result.rows
}

export async function markInvoicePaid(client, loadId) {
  const result = await client.query(
    `UPDATE loads SET invoice_paid_at = now()
      WHERE id = $1 AND invoice_paid_at IS NULL
      RETURNING id`,
    [loadId],
  )
  return result.rows[0] ?? null
}

// The run is over: the driver comes off the load, rests, and is
// available again.
//
// This used to set duty_status = 'off' and hos_remaining_min = NULL, and
// that made the driver INVISIBLE. Every availability and deadhead query
// on the board requires `duty_status <> 'off'`, so a driver who finished
// one load never appeared again -- no deadhead, no nearest-driver, and
// the HOS warning compared against NULL and stopped firing entirely. A
// company whose drivers had all completed a run looked, to the board,
// like a company with no drivers.
//
// 'resting' is the honest state for a driver between loads: not on a
// load, not unavailable. HOS resets because the rest is what resets it.
//
// hos_remaining_min is NOT reset to 660 here any more. That was the one
// write the column had, and it was wrong the moment it happened: a driver
// who has just driven eleven hours does not get eleven more by handing
// over the paperwork. The tick's syncDriverHos (dispatch.service.js)
// derives it from duty_events (037) through hosClock.js's
// driverHosSnapshot -- the rest resets it as the rest is actually taken.
export async function releaseDriver(client, { driverId }) {
  if (!driverId) return
  await client.query(
    `UPDATE drivers SET duty_status = 'resting' WHERE id = $1`,
    [driverId],
  )
}

// Put the driver on duty at dispatch.
export async function setDriverDriving(client, { driverId }) {
  await client.query(
    `UPDATE drivers SET duty_status = 'driving' WHERE id = $1`,
    [driverId],
  )
}

// Move loads in transit onto the status their timing actually warrants.
//
// One statement, two transitions, so the tick cannot leave a load half
// re-classified: 'crit' when the promised delivery time has passed and
// the freight is not there, 'warn' when the current ETA already runs past
// the promise. Ordered by CASE so a load that qualifies for both lands on
// 'crit'. Only touches loads whose status would actually change, so the
// statement is cheap and idempotent.
// Move a load off 'ontime' when the road has gone wrong.
//
// Two different facts, two different statuses:
//
//   'crit'  the promised delivery time has passed and the load is still
//           not delivered. This has happened; it is not a forecast.
//
//   'warn'  the ETA now runs past the promise. Also not a forecast: since
//           migration 027 an ETA only moves when a road event is resolved,
//           so by the time this is true the driver has already called it
//           in and the dispatcher has already chosen what to do about it.
//
// The reveal fraction is gone with delayFactor. It existed because eta_at
// used to be decided at dispatch, which meant the simulator knew at second
// zero which loads would run late; publishing that immediately would have
// put a forecast on the board dressed as a fact, so the flag was held back
// until 60% of the run. There is nothing to hold back now. Keeping it
// would have done the opposite harm -- the chat saying "I am stuck in the
// snow outside Denver" while the board still read on time, two screens
// disagreeing about the same truck.
export async function markLate(client) {
  const result = await client.query(
    `UPDATE loads
        SET status = CASE
              WHEN now() > promised_eta_at THEN 'crit'
              ELSE 'warn'
            END
      WHERE delivered_at IS NULL
        AND promised_eta_at IS NOT NULL
        AND dispatched_at IS NOT NULL
        AND status IN ('ontime', 'warn')
        AND (now() > promised_eta_at OR eta_at > promised_eta_at)
        AND status <> CASE
              WHEN now() > promised_eta_at THEN 'crit'
              ELSE 'warn'
            END
      RETURNING id, status`,
  )
  return result.rows
}

// Take a load back off a driver.
//
// Once a load went to 'ontime' the only exit was the tick: a load
// dispatched to the wrong driver, or to a driver who then could not run
// it, was stuck in transit until it "arrived". Cancelling returns it to
// 'neutral' -- booked, unassigned -- which is where it was before, and
// loads_pending_clean requires driver, truck and dispatched_at to be
// cleared together with it.
//
// Only before delivery. A delivered load has an invoice against it and
// cash has already moved; unwinding that is an accounting question, not
// an UPDATE.
export async function cancelDispatch(client, loadId) {
  const result = await client.query(
    `UPDATE loads
        SET status = 'neutral', driver_id = NULL, truck_id = NULL,
            dispatched_at = NULL, eta_at = NULL, promised_eta_at = NULL
      WHERE id = $1 AND delivered_at IS NULL
        AND status IN ('ontime', 'warn', 'crit')
      RETURNING id, driver_id AS "driverId"`,
    [loadId],
  )
  return result.rows[0] ?? null
}

// Who was on it, so they can be released after the cancel.
export async function getLoadDriver(client, loadId) {
  const result = await client.query(
    `SELECT driver_id AS "driverId" FROM loads WHERE id = $1`,
    [loadId],
  )
  return result.rows[0]?.driverId ?? null
}

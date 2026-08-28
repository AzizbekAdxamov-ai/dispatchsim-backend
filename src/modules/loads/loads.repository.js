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

const LOAD_COLUMNS = `
  l.id, l.origin_city AS "originCity", l.origin_state AS "originState",
  l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
  l.broker, l.commodity,
  l.rate_usd AS "rateUsd", l.distance_mi AS "distanceMi", l.weight_lbs AS "weightLbs",
  l.equipment_type AS "equipmentType", l.equipment_length_ft AS "equipmentLengthFt",
  l.status, l.driver_id AS "driverId", l.truck_id AS "truckId",
  l.booked_at AS "bookedAt", l.pickup_at AS "pickupAt", l.delivery_at AS "deliveryAt",
  l.dispatched_at AS "dispatchedAt", l.eta_at AS "etaAt", l.delivered_at AS "deliveredAt",
  l.payment_terms AS "paymentTerms", l.invoice_paid_at AS "invoicePaidAt",
  l.accessorials,
  l.created_at AS "createdAt", l.updated_at AS "updatedAt"
`

// Compact driver/truck summaries embedded per row. Full driver/truck detail
// lives behind GET /drivers/:id and GET /fleet/trucks/:id — this is just
// enough for a load list row or a load detail header to render without a
// second request.
const DRIVER_TRUCK_LATERAL = `
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

const ROW_SELECT = `
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

export async function getLoadById(id) {
  const result = await query(`${ROW_SELECT} WHERE l.id = $1`, [id])
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
export async function getDashboardCounts() {
  const result = await query(
    `SELECT
       count(*) FILTER (WHERE status <> 'done')::int                  AS "activeLoads",
       count(*) FILTER (WHERE status IN ('ontime','warn','crit'))::int AS "inTransit",
       count(*) FILTER (WHERE status IN ('warn','crit'))::int          AS "atRisk",
       count(*) FILTER (WHERE status <> 'neutral')::int                AS "evaluatedLoads",
       count(*) FILTER (WHERE status IN ('ontime','done'))::int        AS "onTimeLoads"
     FROM loads`,
  )
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
       round(100.0 * count(*) FILTER (WHERE delivered_at <= delivery_at) / count(*))::int AS "onTimePct"
     FROM loads
     WHERE delivered_at IS NOT NULL AND delivered_at >= current_date - $1::int
     GROUP BY 1
     ORDER BY 1`,
    [days],
  )
  return result.rows
}

// Business logic for GET /stats/dashboard. No repository of its own (no
// new table backs it) — it composes counts already exported by
// loads.repository.js, drivers.repository.js and fleet's
// metrics.repository.js. Returns raw structured numbers, never display
// labels/strings: CLAUDE.md's "Hardcoded UI matni yoʻq" rule means the
// stat-tile labels (`stats[].label` in the old mock) are the frontend's
// job to attach, not this service's.

import * as loadsRepo from '../loads/loads.repository.js'
import * as driversRepo from '../drivers/drivers.repository.js'
import * as metricsRepo from '../fleet/metrics.repository.js'

const TREND_DAYS = 7

export function fillDailyTrend(rows, days, valueKey, defaultValue = 0) {
  const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r]))
  const out = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    const row = byDay.get(key)
    out.push({ day: key, [valueKey]: row ? row[valueKey] : defaultValue })
  }
  return out
}

export async function getDashboard() {
  const [counts, revenue, availability, onTimeRows, utilizationRows] = await Promise.all([
    loadsRepo.getDashboardCounts(),
    loadsRepo.getWeeklyRevenue(),
    driversRepo.getAvailabilityCounts(),
    loadsRepo.getOnTimeTrend(TREND_DAYS),
    metricsRepo.getUtilizationTrend(TREND_DAYS),
  ])

  const onTimePct = counts.evaluatedLoads > 0
    ? Math.round((counts.onTimeLoads / counts.evaluatedLoads) * 100)
    : 0

  return {
    stats: {
      activeLoads: counts.activeLoads,
      inTransit: counts.inTransit,
      atRisk: counts.atRisk,
      onTimePct,
      onTimeLoads: counts.onTimeLoads,
      evaluatedLoads: counts.evaluatedLoads,
      driversAvailable: availability.available,
      driversTotal: availability.total,
      weekRevenueUsd: revenue.currentUsd,
      previousWeekRevenueUsd: revenue.previousUsd,
    },
    // A missing delivery day has no percentage; 0 is reserved for actual late deliveries.
    onTimeTrend: fillDailyTrend(onTimeRows, TREND_DAYS, 'onTimePct', null),
    utilizationTrend: utilizationRows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      utilization: r.utilization,
      distanceMi: r.distanceMi,
    })),
  }
}

// ---------------------------------------------------------------------
// GET /stats/compliance -- Compliance > Overview
// ---------------------------------------------------------------------
//
// One screen answering "how clean is the operation right now", composed
// from the readings each compliance module already owns. Nothing here
// recomputes a rule: DQ states come from driverQualification.js's own
// reader (the same one the Qualification screen shows), HOS from the
// drivers table the tick writes, road events from load_events. A failing
// source returns null and says so in `degraded`, because a missing tile
// must read as "not measured", never as "all clear" -- the same
// discipline as alerts.service.js's degraded list.

import * as complianceService from '../compliance/compliance.service.js'
import { query, pool } from '../../db/pool.js'
import { REAL_SEC_PER_SIM_DAY } from '../../constants/simClock.js'
import { REVIEW_THRESHOLD_MIN } from '../hos/repositioning.js'

// Active road events, with the load they stopped. loadEvents owns the
// table; this asks the DB directly for the two columns the tile needs,
// with the same open-event condition the alerts module states.
const OPEN_EVENTS_SQL = `
  SELECT e.id, e.load_id AS "loadId", e.event_type AS "eventType", e.occurred_at AS "occurredAt",
         l.rate_usd AS "rateUsd"
    FROM load_events e
    JOIN loads l ON l.id = e.load_id
   WHERE e.resolved_at IS NULL
     AND e.occurred_at <= now()
   ORDER BY e.occurred_at`

// Unreviewed unidentified driving records older than the 30-minute review
// line (49 CFR 395.32(b) -- the same threshold repositioning.js writes
// against). The ELD's own question: who was driving?
const UNREVIEWED_UNIDENTIFIED_SQL = `
  SELECT count(*)::int AS n,
         coalesce(max(floor(
           EXTRACT(EPOCH FROM (now() - e.started_at)) / ${REAL_SEC_PER_SIM_DAY}
         )), 0)::int AS "oldestDays"
    FROM duty_events e
   WHERE e.driver_id IS NULL
     AND e.origin = 'unidentified'
     AND e.record_status = 'active'
     AND e.annotation IS NULL
     AND (EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) / 60) > $1::int`

export async function getComplianceOverview(opts = {}) {
  // inTx runs fn with a connection: the test's transaction client, or a
  // one-shot pooled client. query(fn) would pass fn as SQL text (found
  // by the smoke test's degraded list, 2026-09-25), so the pool path
  // checks out a client for the same shape every caller gets.
  const inTx = async (fn) => {
    if (opts.client) return fn(opts.client)
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }
  const degraded = []

  async function collect(label, fn) {
    try {
      return await fn()
    } catch (err) {
      console.error(`[stats/compliance] ${label} failed:`, err.message)
      degraded.push(label)
      return null
    }
  }

  const [dq, hosViolations, openEvents, unreviewed] = await Promise.all([
    collect('driverQualification', () => complianceService.listDriverQualification({ client: opts.client ?? null })),
    collect('hosViolations', () => complianceService.listViolations({ days: 1 })),
    collect('openEvents', () =>
      // inTx takes the function and calls it with the connection -- a
      // .then chained on its return value failed on every live request
      // (found by the smoke test's degraded list, 2026-09-25).
      inTx(async (client) => (await client.query(OPEN_EVENTS_SQL)).rows)),
    collect('unreviewedUnidentified', () =>
      inTx(async (client) => (await client.query(UNREVIEWED_UNIDENTIFIED_SQL, [REVIEW_THRESHOLD_MIN])).rows[0])),
  ])

  // -- DQ: clear / attention / action drivers, and every open document --
  const dqDrivers = dq?.drivers ?? []
  const dqCounts = { clear: 0, attention: 0, action: 0 }
  const openDocuments = []
  for (const d of dqDrivers) {
    dqCounts[d.fileState] = (dqCounts[d.fileState] ?? 0) + 1
    for (const doc of d.documents) {
      if (doc.status === 'expiring' || doc.status === 'expired' || doc.status === 'missing' || doc.status === 'suspended') {
        openDocuments.push({
          driverId: d.driver.id,
          driverName: d.driver.name,
          document: doc.type,
          status: doc.status,
          expiresOn: doc.expiresOn,
          daysLeft: doc.daysLeft,
          cfr: (dq?.documentTypes ?? []).find((t) => t.key === doc.type)?.cfr ?? null,
        })
      }
    }
  }
  // Soonest expiry first: the renewal calendar is what the carrier works
  // down. Documents without a date go last.
  openDocuments.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))

  // -- HOS: violations in today's sim day, clocks at/near their limit --
  const hosDrivers = hosViolations?.drivers ?? []
  const violatedDrivers = hosDrivers.filter((d) => d.violationMinutes > 0)

  // -- Road events: the trucks stopped right now --
  const events = (openEvents ?? []).map((e) => ({
    loadId: e.loadId,
    eventType: e.eventType,
    rateUsd: e.rateUsd,
  }))

  return {
    asOf: new Date().toISOString(),
    degraded,
    drivers: {
      total: dqDrivers.length,
      clear: dqCounts.clear,
      attention: dqCounts.attention,
      action: dqCounts.action,
    },
    hos: {
      driversWithViolationsToday: violatedDrivers.length,
      violationMinutesToday: violatedDrivers.reduce((sum, d) => sum + d.violationMinutes, 0),
    },
    vehicles: {
      stoppedEvents: events.length,
      events,
    },
    eld: {
      unreviewedUnidentified: unreviewed?.n ?? null,
      oldestUnreviewedDays: unreviewed?.oldestDays ?? null,
      reviewThresholdMin: REVIEW_THRESHOLD_MIN,
    },
    openDocuments,
  }
}

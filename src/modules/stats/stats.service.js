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

function fillDailyTrend(rows, days, valueKey, defaultValue = 0) {
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
    onTimeTrend: fillDailyTrend(onTimeRows, TREND_DAYS, 'onTimePct'),
    utilizationTrend: utilizationRows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      utilization: r.utilization,
      distanceMi: r.distanceMi,
    })),
  }
}

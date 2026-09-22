// Compliance > Driver HOS. The columns and their order follow the fleet
// platform's Hours of Service report (vault: 01-Projects/Dispatch-
// atamalar-xaritasi.md, source https://kb.samsara.com/hc/en-us/articles/
// 360043794691). Every clock is hosClock.js's driverHosClocks -- nothing
// here computes a rule.
//
// Minutes in the response are HOS minutes (literal hours of service),
// not real minutes: "Drive remaining 480" means eight hours of driving
// left, which on the compressed calendar passes in 2 minutes 40 seconds.

import { AppError } from '../../lib/errors.js'
import { REAL_SEC_PER_SIM_DAY, REAL_MS_PER_SIM_DAY, simDaysToMs } from '../../constants/simClock.js'
import { driverHosClocks, findViolationsReal, VIOLATION_TYPES, HOS_LOOKBACK_HOURS } from '../../constants/hosClock.js'
import * as repo from './compliance.repository.js'

export async function listDriverHos() {
  const since = new Date(Date.now() - simDaysToMs(HOS_LOOKBACK_HOURS / 24))
  const rows = await repo.driversHos({ since, realSecPerSimDay: REAL_SEC_PER_SIM_DAY })
  const drivers = rows.map((r) => {
    const nowMs = new Date(r.now).getTime()
    const nextDayMs = r.nextDayStart == null ? null : new Date(r.nextDayStart).getTime()
    const clocks = driverHosClocks(r.events, nowMs, nextDayMs)
    return {
      driver: { id: r.driverId, name: r.driverName },
      vehicle: r.truckId ? { id: r.truckId, make: r.truckMake, model: r.truckModel } : null,
      ...clocks,
    }
  })
  return { drivers, asOf: rows[0]?.now ?? new Date().toISOString() }
}

export async function driverDayLog({ driverId, dayOffset }) {
  const driver = await repo.findDriver(driverId)
  if (!driver) throw new AppError('DRIVER_NOT_FOUND')
  const log = await repo.driverDayLog({ driverId, realSecPerSimDay: REAL_SEC_PER_SIM_DAY, dayOffset })
  return {
    driver: { id: driver.id, name: driver.name },
    day: log?.day ?? null,
    dayStart: log?.dayStart ?? null,
    dayEnd: log?.dayEnd ?? null,
    now: log?.now ?? null,
    events: log?.events ?? [],
  }
}

// Compliance > HOS Violations over the last `days` simulated days
// (today counts as one). A violation is driving while hosState said no
// (hosClock.js's findViolations); "Violations (Time)" is its total HOS
// minutes, "Days" the number of distinct days it touched -- the
// platform's own two columns (https://kb.samsara.com/hc/en-us/articles/
// 360023208811). The log read goes back the range PLUS the full HOS
// lookback, so a clock that was already running out when the range
// began is measured from where it really started.
export async function listViolations({ days }) {
  const since = new Date(Date.now() - simDaysToMs(days + HOS_LOOKBACK_HOURS / 24))
  const rows = await repo.violationsSource({ since, realSecPerSimDay: REAL_SEC_PER_SIM_DAY })
  const drivers = []
  for (const r of rows) {
    const nowMs = new Date(r.now).getTime()
    const todayStartMs = r.todayStart == null ? null : new Date(r.todayStart).getTime()
    // No company calendar yet -- no days to count in, and nothing driven.
    if (todayStartMs == null) continue
    const rangeStartMs = todayStartMs - (days - 1) * REAL_MS_PER_SIM_DAY
    const violations = findViolationsReal(r.events, nowMs)
      .filter((v) => v.endedAt > rangeStartMs)
      .map((v) => ({
        startedAt: new Date(Math.max(v.startedAt, rangeStartMs)).toISOString(),
        endedAt: new Date(v.endedAt).toISOString(),
        minutes: v.minutes,
        dayOffset: Math.floor((Math.max(v.startedAt, rangeStartMs) - todayStartMs) / REAL_MS_PER_SIM_DAY),
        types: v.codes.map((code) => ({ code, ...VIOLATION_TYPES[code] })),
      }))
    drivers.push({
      driver: { id: r.driverId, name: r.driverName },
      violationMinutes: violations.reduce((sum, v) => sum + v.minutes, 0),
      days: new Set(violations.map((v) => v.dayOffset)).size,
      violations,
    })
  }
  return {
    days,
    // Start of today's simulated day, so the page can place each
    // violation on its day's 24-hour clock.
    todayStart: rows[0]?.todayStart ?? null,
    dayMs: REAL_MS_PER_SIM_DAY,
    types: Object.entries(VIOLATION_TYPES).map(([code, t]) => ({ code, ...t })),
    drivers,
  }
}

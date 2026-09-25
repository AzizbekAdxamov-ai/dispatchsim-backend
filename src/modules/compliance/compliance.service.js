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
import { withTransaction } from '../../db/pool.js'
import { REAL_SEC_PER_SIM_DAY, REAL_MS_PER_SIM_DAY, simDaysToMs } from '../../constants/simClock.js'
import { driverHosClocks, findViolationsReal, VIOLATION_TYPES, HOS_LOOKBACK_HOURS, HOS_TIME_SCALE } from '../../constants/hosClock.js'
import * as repo from './compliance.repository.js'
import {
  readDocumentStatus, fileState, dispatchClear, daysUntil,
  MEDICAL_EXPIRING_DAYS, MVR_EXPIRING_DAYS, MVR_MAX_AGE_DAYS, DQ_DOCUMENT_TYPES,
} from '../../constants/driverQualification.js'

// Compliance > Unassigned HOS. The screen the 30-minute rule makes
// necessary: repositioning.js writes a driving record with no driver
// whenever the empty truck rolls to the next shipper, and 49 CFR 395.32
// makes reviewing those records the carrier's job. Each one is either
// assigned to the driver who actually drove it (395.32(d): the record is
// changed -- the original marked 'inactive-changed', a replacement added
// in the driver's name, both carrying the carrier's note) or annotated
// with why it is nobody's time (the original stays active, carrying the
// note).

// The queue is grouped by simulated day, so it reads the same days every
// other compliance screen names. A week of simulated time is 14 real
// minutes; repositioning happens between loads, so the queue only ever
// holds recent drives. $2/$3 are the sim clock's own numbers (see
// compliance.sql.js's header).
const UNASSIGNED_DAYS_BACK = 7

// The review screen. One row per truck per simulated day; segments carry
// the ids the assign/annotate endpoints act on. Minutes are literal HOS
// minutes, like every other compliance screen (rounding at the screen's
// own threshold is one rule, not two -- repositioning.js computes the
// block, this only names it).
// opts.client: a test's rolled-back transaction, so the fixture the test
// wrote is the queue the service reads (see annotateUnassignedHos).
export async function listUnassignedHos(opts = {}) {
  const rows = await repo.unassignedHos({
    realSecPerSimDay: REAL_SEC_PER_SIM_DAY,
    daysBack: UNASSIGNED_DAYS_BACK,
  }, opts.client ?? null)
  const nowMs = Date.now()
  const days = rows
    .map((r) => ({
      truck: { id: r.truckId, make: r.truckMake, model: r.truckModel },
      day: r.day,
      dayStart: r.dayStart,
      dayEnd: r.dayEnd,
      segments: (r.segments ?? []).map((s) => {
        const minutes = Math.max(1, Math.round(((new Date(s.endedAt) - new Date(s.startedAt)) * HOS_TIME_SCALE) / 60000))
        return {
          ...s,
          minutes,
          // The annotation IS the review (395.32(c): the carrier notes the
          // reason on the record). Under 038's original CHECK unidentified
          // rows were born annotated, so this flag never mattered at
          // birth; since 042 a record is born without the note, and the
          // review is what writes it (assign writes a replacement).
          awaitingReview: !s.annotation,
        }
      }),
      unreviewed: (r.segments ?? []).filter((s) => !s.annotation).length,
    }))
    .filter((r) => r.segments.length > 0)
    .sort((a, b) => new Date(b.dayStart) - new Date(a.dayStart))
  return { asOf: new Date(nowMs).toISOString(), days }
}

// 395.32(d). The driver named here is the driver who actually drove; from
// this moment the minutes are THEIRS, so their clocks run the record down.
// opts.client: a test's rolled-back transaction (see annotateUnassignedHos).
export async function assignUnassignedHos({ eventId, driverId, annotation }, opts = {}) {
  const inTx = (fn) => (opts.client ? fn(opts.client) : withTransaction(fn))
  const event = await repo.findDutyEvent(eventId, opts.client)
  if (!event || event.driverId != null || event.origin !== 'unidentified') {
    throw new AppError('EVENT_NOT_FOUND')
  }
  if (event.recordStatus !== 'active') {
    throw new AppError('EVENT_ALREADY_REVIEWED')
  }
  const driver = await repo.findDriver(driverId, opts.client)
  if (!driver) throw new AppError('DRIVER_NOT_FOUND')
  if (!event.hasTruck) throw new AppError('EVENT_NOT_FOUND')

  return inTx(async (client) => {
    const marked = await repo.markInactiveChanged(client, event.id)
    if (!marked) throw new AppError('EVENT_NOT_FOUND')
    const inserted = await repo.insertReplacement(client, {
      driverId: driver.id,
      loadId: event.loadId,
      truckId: event.truckId,
      status: event.status,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      annotation,
    })
    // The original was marked; a driver who already has an active log at
    // that instant makes the replacement a no-op (037's one-active-start
    // guard). Rolling back leaves the original as it was -- half an edit
    // is not an edit.
    if (!inserted) throw new AppError('EVENT_ALREADY_REVIEWED')
    return { assigned: true, driver: { id: driver.id, name: driver.name } }
  })
}

// The other branch: the drive is explained, not owned. The original stays
// active -- annotating never invents or moves anyone's time -- and the
// note says why it is nobody's log. A record already marked inactive is
// already reviewed; that is a 409, not a 404.
//
// opts.client: a test's rolled-back transaction, exactly the seam
// replan.service.js's inTx opens. Production calls this with no options
// and the work happens on its own transaction.
export async function annotateUnassignedHos({ eventId, annotation }, opts = {}) {
  const inTx = (fn) => (opts.client ? fn(opts.client) : withTransaction(fn))
  const event = await repo.findDutyEvent(eventId, opts.client)
  if (!event || event.driverId != null || event.origin !== 'unidentified') {
    throw new AppError('EVENT_NOT_FOUND')
  }
  if (event.recordStatus !== 'active') {
    throw new AppError('EVENT_ALREADY_REVIEWED')
  }
  if (!event.hasTruck) throw new AppError('EVENT_NOT_FOUND')
  const updated = await inTx((client) => repo.annotateEvent(client, { eventId: event.id, annotation }))
  if (!updated) throw new AppError('EVENT_ALREADY_REVIEWED')
  return { annotated: true }
}

// Compliance > Driver Qualification. The carrier's paperwork duty (49 CFR
// 391 Subpart E) read as it actually ages: each document's stored status is
// re-timed against the sim clock, so an expiry the seed wrote as future
// becomes 'expiring' and then 'expired' as the calendar moves. The worst
// document names the file's state; nothing here blocks anything -- the
// fact travels, the dispatcher decides (dispatchClear() says the same in
// the constants module, for the places that do check).
export async function listDriverQualification(opts = {}) {
  const rows = await repo.driverQualification(opts.client ?? null)
  const todayMs = Date.now()
  const drivers = rows.map((r) => {
    // 005's own expiry column, timed by the same reading as 039's.
    const cdlStatus = readDocumentStatus(r.cdlStatus ?? 'valid', r.licenseExpiresOn, todayMs)
    const medicalStatus = readDocumentStatus(r.medicalStatus ?? 'valid', r.medicalExpiresOn, todayMs)
    // MVR is dated by WHEN IT WAS PULLED, not when it expires: the review
    // goes stale (MVR_MAX_AGE_DAYS), the violations count is its payload.
    const mvrAgeDays = daysUntil(r.mvrCheckedOn, todayMs) == null
      ? null
      : Math.ceil((todayMs - new Date(r.mvrCheckedOn).getTime()) / REAL_MS_PER_SIM_DAY)
    const mvrStatus = mvrAgeDays == null
      ? (r.mvrStatus ?? 'valid')
      : (mvrAgeDays > MVR_MAX_AGE_DAYS ? 'expired' : (mvrAgeDays > MVR_MAX_AGE_DAYS - MVR_EXPIRING_DAYS ? 'expiring' : 'valid'))
    const daStatus = r.daStatus ?? 'missing'

    const documents = [
      { type: 'cdl', status: cdlStatus, expiresOn: r.licenseExpiresOn, daysLeft: daysUntil(r.licenseExpiresOn, todayMs) },
      { type: 'medical', status: medicalStatus, expiresOn: r.medicalExpiresOn, daysLeft: daysUntil(r.medicalExpiresOn, todayMs) },
      { type: 'mvr', status: mvrStatus, expiresOn: null, daysLeft: mvrAgeDays == null ? null : MVR_MAX_AGE_DAYS - mvrAgeDays, violations: r.mvrViolations ?? 0 },
      { type: 'drugAlcohol', status: daStatus, expiresOn: null, daysLeft: null },
    ]
    const statuses = documents.map((d) => d.status)
    return {
      driver: { id: r.driverId, name: r.driverName },
      dutyStatus: r.dutyStatus,
      cdlClass: r.cdlClass,
      hosRemainingMin: r.hosRemainingMin,
      currentLoadId: r.currentLoadId,
      fileMissing: r.dqRowExists === 0,
      documents,
      fileState: fileState(statuses),
      dispatchClear: dispatchClear(statuses),
    }
  })
  return {
    asOf: new Date(todayMs).toISOString(),
    windows: {
      medicalExpiringDays: MEDICAL_EXPIRING_DAYS,
      mvrExpiringDays: MVR_EXPIRING_DAYS,
      mvrMaxAgeDays: MVR_MAX_AGE_DAYS,
    },
    documentTypes: DQ_DOCUMENT_TYPES,
    drivers,
  }
}

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

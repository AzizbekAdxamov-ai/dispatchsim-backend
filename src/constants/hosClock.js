// The hours-of-service clock math itself -- pure functions, no db, no
// Date.now(). Every time value (an event's startedAt/endedAt, or `now`) is
// a parameter, either milliseconds since epoch or a Date; nothing in this
// file reads the wall clock.
//
// This is the SECOND rule this project models, and it exists because the
// first one (src/constants/hos.js, 49 CFR 395.3(a)(1) -- 10 consecutive
// hours off duty) was written down as the ONLY honest claim the codebase
// could make, for a specific reason: drivers.hours_today_min,
// hours_week_min and hos_remaining_min have no runtime writer, so any rule
// built on them would read a stale number forever.
//
// A second, sharper problem sits next to that one. scripts/seed/facilities.js
// computes DRIVING_HOURS_PER_DAY as `24 - REQUIRED_REST_HOURS` (= 14) and
// then DAILY_DRIVE_MI = 14h * 55mph = 770mi. Fourteen hours is the DUTY
// WINDOW (395.3(a)(2)) -- the clock inside which a driver may drive at
// all -- not the driving limit. The driving limit is 11 hours
// (395.3(a)(3)). Meanwhile src/modules/loads/loads.repository.js sets
// hos_remaining_min = 660, which IS 11 hours, correctly. One codebase,
// two different legal numbers for "how long can this driver drive today."
//
// This file writes down the real distinction -- and the rest of the rules
// that fall out of it -- as pure functions, so the next phase (wiring a
// live duty_events log, fixing facilities.js's DAILY_DRIVE_MI, and giving
// hos_remaining_min an actual writer) has correct arithmetic to call
// instead of re-deriving it under deadline.
//
// Source: https://www.fmcsa.dot.gov/regulations/hours-service/summary-hours-service-regulations
// (checked 2026-09-19), property-carrying driver rules.
//
// ---------------------------------------------------------------------
// What this file does NOT model, on purpose
// ---------------------------------------------------------------------
//
// - The adverse driving conditions exception (49 CFR 395.1(b)(1)) grants
//   +2 hours on the driving limit and the duty window when weather or
//   road conditions the driver could not have known about at dispatch
//   made the trip longer. This project has no weather or road-conditions
//   system, so there is nothing to trigger it on. ADVERSE_EXTENSION_HOURS
//   below is the number, written down for when that system exists; no
//   function here applies it.
// - The short-haul exception (395.1(e)) exempts a driver who works within
//   a 150 air-mile radius and returns to the reporting location within 14
//   hours from the driver's log requirement entirely. This project does
//   not model a driver's reporting location or a return-to-base concept,
//   so there is no "is this driver short-haul" question this file can
//   answer.
// - A fuel stop being on-duty-not-driving time rather than off-duty time.
//   stop_visits exists and could tell a caller when a driver was stopped
//   for fuel, but wiring that into an events log for this module is the
//   next phase's job, not this one's.
// - Which of the two weekly schedules -- 60 hours/7 days or 70 hours/8
//   days (395.3(b)(1) vs (b)(2)) -- actually governs a given carrier.
//   That is a fleet-level operating choice this module is never told.
//   hosState reports both dutyMinutesInWindow7Day and ...8Day, and
//   `limits` treats EITHER one running out as blocking -- the reading
//   that never wrongly permits driving. A caller that knows its fleet
//   runs the 70/8 schedule can ignore the 7-day entry.
// - The exact regulatory mechanics of a sleeper-berth split against a
//   14-hour window that was already partway spent. 395.1(g)(1) excludes
//   ONLY the two split periods from the window that was running when they
//   started -- it does not hand the driver a fresh 14 hours. Reconstructing
//   that precisely requires tracking which window a split's hours fall
//   inside. This module takes the simpler (and slightly more generous)
//   reading: a completed qualifying split resets the driving clock and the
//   duty window the same way a full 10-hour break does, dated to the end
//   of the split's second period. Documented here rather than silently
//   assumed.

import { REQUIRED_REST_HOURS } from './hos.js'
import { REAL_MS_PER_SIM_DAY } from './simClock.js'

// A duration as a person reads it: "816d 15h", "10h 05m", "45m". The limit
// facts below said "1175939 minutes used since coming on duty" until
// 2026-10-08 -- true, on the company clock, and unreadable.
export function dutyDuration(min) {
  const abs = Math.max(0, Math.round(min))
  const d = Math.floor(abs / 1440)
  const h = Math.floor((abs % 1440) / 60)
  const m = abs % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

// ---------------------------------------------------------------------
// Constants -- every one a legal number, not a guess
// ---------------------------------------------------------------------

// A driver may drive at most this many hours following 10 consecutive
// hours off duty. This is the DRIVING limit -- see DUTY_WINDOW_HOURS
// below for the different, larger number it is routinely confused with
// (that confusion is the bug this file exists to stop).
// 49 CFR 395.3(a)(3)
export const DRIVING_LIMIT_HOURS = 11

// A driver may not drive beyond the 14th hour after coming on duty,
// following 10 consecutive hours off duty -- regardless of how many of
// those 14 hours were spent driving versus on-duty-not-driving. This
// window does not pause for a break or a fuel stop; only a qualifying
// sleeper-berth split (SLEEPER_BERTH_MIN_HOURS / SLEEPER_OFF_MIN_HOURS
// below) is excluded from it.
// 49 CFR 395.3(a)(2)
export const DUTY_WINDOW_HOURS = 14

// After this many cumulative hours of DRIVING (not elapsed time) since
// the last qualifying break, a driver may not drive again until taking
// one.
// 49 CFR 395.3(a)(3)(ii)
export const BREAK_AFTER_DRIVING_HOURS = 8

// The break itself: any 30 consecutive minutes NOT driving. Off duty,
// sleeper berth, or on-duty-not-driving all satisfy it -- the regulation
// requires the driver not be driving for the 30 minutes, not that the
// driver be off the clock.
// 49 CFR 395.3(a)(3)(ii)
export const BREAK_MINUTES = 30

// A driver may not drive after being on duty 60 hours in 7 consecutive
// days (carriers not operating every day of the week).
// 49 CFR 395.3(b)(1)
export const WEEKLY_LIMIT_HOURS_7DAY = 60

// ...or 70 hours in 8 consecutive days (carriers operating every day).
// 49 CFR 395.3(b)(2)
export const WEEKLY_LIMIT_HOURS_8DAY = 70

// 34 or more consecutive hours off duty restarts the 7/8-day period: on-duty
// hours from before the restart no longer count toward the 60/70-hour
// limit.
// 49 CFR 395.3(c)
export const RESTART_HOURS = 34

// A sleeper-berth split's larger half must be at least this long, and
// must actually be spent in the sleeper berth (not just off duty).
// 49 CFR 395.1(g)(1)
export const SLEEPER_BERTH_MIN_HOURS = 7

// The split's other half must be at least this long, and may be off duty
// or sleeper berth. The two together must total at least
// REQUIRED_REST_HOURS; neither period counts against the 14-hour window.
// 49 CFR 395.1(g)(1)
export const SLEEPER_OFF_MIN_HOURS = 2

// How many extra hours the adverse driving conditions exception grants on
// both the driving limit and the duty window. Not applied anywhere in
// this file -- see "What this file does NOT model" above.
// 49 CFR 395.1(b)(1)
export const ADVERSE_EXTENSION_HOURS = 2

// REQUIRED_REST_HOURS (10 consecutive hours off duty, 49 CFR 395.3(a)(1))
// is NOT redeclared here -- it is hos.js's constant, imported, so the two
// files never state the same legal number twice.
export { REQUIRED_REST_HOURS }

// ---------------------------------------------------------------------
// Duty statuses -- the ELD's four, and the drivers.duty_status column's
// different four
// ---------------------------------------------------------------------

// The four duty statuses a driver's record of duty status (ELD or paper
// log) is built from, per 49 CFR 395.8's recordkeeping categories. This
// is the status vocabulary hosState's `events` are written in.
export const DUTY_STATUS = Object.freeze({
  OFF_DUTY: 'off-duty',
  SLEEPER_BERTH: 'sleeper-berth',
  DRIVING: 'driving',
  ON_DUTY_NOT_DRIVING: 'on-duty-not-driving',
})

// drivers.duty_status (migration 005_drivers.sql, constraint
// drivers_duty_status) is a DIFFERENT, coarser vocabulary that predates
// this file and is not changed here -- that migration is the next phase's
// job. test/hosClock.test.js pins these four strings against that
// migration's CHECK the same way test/truckWear.test.js pins
// DAILY_DISTANCE_CAP_MI against migration 009's CHECK: if the migration's
// allowed values ever change, that test goes red until this list is
// updated to match.
export const DB_DUTY_STATUSES = Object.freeze(['driving', 'on-duty', 'resting', 'off'])

// A starting mapping from the ELD's four statuses to drivers.duty_status's
// four, for whichever phase wires this module to that column. It is NOT
// exact: the db column has no separate "sleeper berth" bucket, so this
// maps SLEEPER_BERTH to 'resting' on the reading that "resting" means
// "currently accruing time toward a required rest period", which sleeper
// berth time does and plain off-duty time also can. A driver who is
// off duty but NOT on a qualifying rest clock (waiting at a receiver, for
// instance) has nowhere honest to go in this mapping -- that is exactly
// the kind of gap a duty_events migration should resolve by giving the db
// the ELD's own four statuses, rather than this file guessing harder.
// (037 did: duty_events stores the four statuses; drivers.duty_status is
// only the coarse, derived view.)
export const DUTY_STATUS_TO_DB_STATUS = Object.freeze({
  [DUTY_STATUS.DRIVING]: 'driving',
  [DUTY_STATUS.ON_DUTY_NOT_DRIVING]: 'on-duty',
  [DUTY_STATUS.SLEEPER_BERTH]: 'resting',
  // NOT 'off'. In drivers.duty_status 'off' means "not working for this
  // company right now" -- every availability and deadhead query on the
  // load board filters on duty_status <> 'off' (loads.repository.js's
  // releaseDriver and hr.service.js both explain the invisible-driver bug
  // that came from writing 'off' between loads). An ELD Off Duty period is
  // a driver resting on the road, which is exactly what 'resting' means.
  [DUTY_STATUS.OFF_DUTY]: 'resting',
})

const REST_STATUSES = new Set([DUTY_STATUS.OFF_DUTY, DUTY_STATUS.SLEEPER_BERTH])
const NON_DRIVING_STATUSES = new Set([
  DUTY_STATUS.OFF_DUTY,
  DUTY_STATUS.SLEEPER_BERTH,
  DUTY_STATUS.ON_DUTY_NOT_DRIVING,
])
const ON_DUTY_STATUSES = new Set([DUTY_STATUS.DRIVING, DUTY_STATUS.ON_DUTY_NOT_DRIVING])

// ---------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------

// Named msOf, not toMs -- minutesDriving/minutesOnDuty below take a
// parameter literally called `toMs` (the spec's own signature), and a
// function with the same name as a parameter would be shadowed by it.
function msOf(t) {
  if (t instanceof Date) return t.getTime()
  // ISO strings are what planStops' dutyTimeline and JSON round-trips
  // carry; without this, arithmetic on them is NaN and the event is
  // silently dropped by normalizeEvents' isFinite filter.
  if (typeof t === 'string') return Date.parse(t)
  return t
}

// Sorts, normalizes to milliseconds, and drops any zero-or-negative-length
// event -- a log with a duplicate timestamp or an out-of-order write
// should not silently corrupt the arithmetic below.
// An event with no endedAt is the driver's CURRENT status -- an ELD log
// always has exactly one of those, and it is the one that matters most.
//
// `openEndMs` says where an open event runs to. Callers asking "what has
// happened by now" pass now: a driver six hours into a run has driven six
// hours, and dropping the open event (which a plain isFinite(endedAt)
// filter quietly does) would leave that live stint out of every total --
// the driver would read as fresh, and a driver forty minutes into a break
// would read as still owing one.
//
// Callers asking "which rests have been COMPLETED" (restQualifies,
// splitSleeperPairs) pass nothing, and an open event is dropped: a rest
// still in progress has not yet qualified as anything.
function normalizeEvents(events, openEndMs) {
  return (events || [])
    .map((e) => {
      const startedAt = msOf(e.startedAt)
      const endedAt = e.endedAt == null ? openEndMs : msOf(e.endedAt)
      return { status: e.status, startedAt, endedAt }
    })
    .filter((e) => Number.isFinite(e.startedAt) && Number.isFinite(e.endedAt) && e.endedAt > e.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt)
}

function minutesBetween(run) {
  return (run.end - run.start) / 60000
}

// Sums the minutes of normalized events matching `predicate`, clipped to
// [fromMs, toMs). Shared by minutesDriving and minutesOnDuty.
function sumStatusMinutes(normEvents, fromMs, toMs, predicate) {
  let total = 0
  for (const e of normEvents) {
    if (!predicate(e.status)) continue
    const start = Math.max(e.startedAt, fromMs)
    const end = Math.min(e.endedAt, toMs)
    if (end > start) total += (end - start) / 60000
  }
  return total
}

// Merges consecutive (contiguous -- no gap, no interruption) events
// matching `predicate` into runs. An event that does not match breaks the
// run, even if a later matching event starts again -- that gap is exactly
// what makes two rest periods separate periods instead of one.
function mergeRuns(normEvents, predicate) {
  const runs = []
  let current = null
  for (const e of normEvents) {
    if (predicate(e.status)) {
      if (current && e.startedAt <= current.end) {
        current.end = Math.max(current.end, e.endedAt)
      } else {
        if (current) runs.push(current)
        current = { start: e.startedAt, end: e.endedAt }
      }
    } else if (current) {
      runs.push(current)
      current = null
    }
  }
  if (current) runs.push(current)
  return runs
}

// ---------------------------------------------------------------------
// Public aggregators
// ---------------------------------------------------------------------

// Minutes spent driving within [fromMs, toMs).
export function minutesDriving(events, fromMs, toMs) {
  return sumStatusMinutes(normalizeEvents(events, msOf(toMs)), msOf(fromMs), msOf(toMs), (s) => s === DUTY_STATUS.DRIVING)
}

// Minutes of ON-DUTY time (driving + on-duty-not-driving -- 395.2's "on
// duty time" includes both) within [fromMs, toMs). This is what the
// 60/70-hour weekly limits count, not driving time alone.
export function minutesOnDuty(events, fromMs, toMs) {
  return sumStatusMinutes(normalizeEvents(events, msOf(toMs)), msOf(fromMs), msOf(toMs), (s) => ON_DUTY_STATUSES.has(s))
}

// Does at least one qualifying rest period exist anywhere in `events`:
// either a single contiguous off-duty/sleeper-berth run of
// REQUIRED_REST_HOURS or more, or a completed sleeper-berth split
// (see splitSleeperPairs)? A fact about the log, not about "now" --
// hosState uses the same two checks anchored to a specific instant.
export function restQualifies(events) {
  const norm = normalizeEvents(events)
  const restRuns = mergeRuns(norm, (s) => REST_STATUSES.has(s))
  if (restRuns.some((r) => minutesBetween(r) >= REQUIRED_REST_HOURS * 60)) return true
  return splitSleeperPairsFromNorm(norm).length > 0
}

// Finds every valid sleeper-berth split pair in `events`: a contiguous
// sleeper-berth run of at least SLEEPER_BERTH_MIN_HOURS (the anchor) paired
// with a SEPARATE (driving- or on-duty-interrupted) off-duty/sleeper-berth
// run of at least SLEEPER_OFF_MIN_HOURS (the partner), together totaling
// at least REQUIRED_REST_HOURS. "Separate" matters: if nothing but the
// anchor's own off-duty extension follows it with no driving in between,
// that is one continuous rest period (covered by restQualifies's plain
// 10-hour check), not a split.
//
// Returns every valid (anchor, partner) combination, sorted by when the
// pair COMPLETES (the later of the two runs' ends) -- ascending, so the
// last entry is the most recently completed split.
export function splitSleeperPairs(events) {
  return splitSleeperPairsFromNorm(normalizeEvents(events))
}

function splitSleeperPairsFromNorm(norm) {
  const sleeperOnlyRuns = mergeRuns(norm, (s) => s === DUTY_STATUS.SLEEPER_BERTH)
  const restRuns = mergeRuns(norm, (s) => REST_STATUSES.has(s))

  const anchors = sleeperOnlyRuns.filter((r) => minutesBetween(r) >= SLEEPER_BERTH_MIN_HOURS * 60)
  const partners = restRuns.filter((r) => minutesBetween(r) >= SLEEPER_OFF_MIN_HOURS * 60)

  const pairs = []
  for (const anchor of anchors) {
    // The restRun that contains this anchor (off-duty immediately
    // attached to the sleeper time, no driving between) is not a valid
    // partner for it -- pairing an anchor with its own containing run
    // would count the same off-duty minutes twice.
    const ownRestRun = restRuns.find((r) => r.start <= anchor.start && r.end >= anchor.end)
    for (const partner of partners) {
      if (partner === ownRestRun) continue
      const anchorMin = minutesBetween(anchor)
      const partnerMin = minutesBetween(partner)
      if (anchorMin + partnerMin < REQUIRED_REST_HOURS * 60) continue
      pairs.push({
        anchor,
        partner,
        totalMinutes: anchorMin + partnerMin,
        completedAt: Math.max(anchor.end, partner.end),
      })
    }
  }
  return pairs.sort((a, b) => a.completedAt - b.completedAt)
}

// ---------------------------------------------------------------------
// hosState -- the one function that answers "may this driver drive right
// now, and why or why not"
// ---------------------------------------------------------------------

// events: time-ordered [{ status, startedAt, endedAt }], status one of
// DUTY_STATUS's four values. now: the instant to evaluate. Both accept
// milliseconds-since-epoch or Date.
//
// Returns facts, not verdicts. `limits` lists which CFR-numbered rule(s)
// are currently blocking driving -- it can hold more than one at once
// (a driver can simultaneously be out of driving hours AND out of duty
// window AND out of weekly hours) -- and `mayDrive` is exactly
// `limits.length === 0`, never an independent judgment call.
export function hosState(events, now) {
  const nowMs = msOf(now)
  const norm = normalizeEvents(events, nowMs)

  // -- Find the most recent qualifying reset before `now`: either a full
  // REQUIRED_REST_HOURS off-duty/sleeper-berth run, or a completed
  // sleeper-berth split. See the file header for why a split is treated
  // as a full reset here rather than modeling its narrower carve-out.
  const restRuns = mergeRuns(norm, (s) => REST_STATUSES.has(s))
  let lastResetEnd = null
  for (const r of restRuns) {
    if (r.end <= nowMs && minutesBetween(r) >= REQUIRED_REST_HOURS * 60) {
      if (lastResetEnd == null || r.end > lastResetEnd) lastResetEnd = r.end
    }
  }
  for (const pair of splitSleeperPairsFromNorm(norm)) {
    if (pair.completedAt <= nowMs) {
      if (lastResetEnd == null || pair.completedAt > lastResetEnd) lastResetEnd = pair.completedAt
    }
  }
  // No qualifying reset anywhere in the log: this module does not assume
  // an infinite driving streak. It treats the start of the earliest
  // recorded event as the boundary -- the same reading a real ELD log
  // gives, where history before the record begins is simply not visible,
  // and a driver logging in for the first time is assumed rested (the same
  // assumption src/constants/hos.js makes for "never delivered a load").
  if (lastResetEnd == null) {
    lastResetEnd = norm.length > 0 ? norm[0].startedAt : nowMs
  }

  // -- Duty window: starts at the first on-duty (driving or
  // on-duty-not-driving) event at or after the reset. Until the driver
  // comes on duty, the window has not started and nothing is used.
  let dutyWindowStartedAt = null
  for (const e of norm) {
    if (!ON_DUTY_STATUSES.has(e.status)) continue
    if (e.startedAt < lastResetEnd || e.startedAt > nowMs) continue
    if (dutyWindowStartedAt == null || e.startedAt < dutyWindowStartedAt) dutyWindowStartedAt = e.startedAt
  }
  const windowMinutesUsed = dutyWindowStartedAt == null ? 0 : (nowMs - dutyWindowStartedAt) / 60000
  const windowMinutesRemaining = Math.max(0, DUTY_WINDOW_HOURS * 60 - windowMinutesUsed)

  // -- Driving limit: cumulative driving minutes since the reset, wherever
  // in the window they fall.
  const drivingMinutesSinceRest = sumStatusMinutes(
    norm, lastResetEnd, nowMs, (s) => s === DUTY_STATUS.DRIVING,
  )
  const drivingMinutesRemaining = Math.max(0, DRIVING_LIMIT_HOURS * 60 - drivingMinutesSinceRest)

  // -- Break: cumulative driving minutes since the last qualifying break
  // (any 30+ consecutive minutes not driving), or since the reset if none
  // has happened yet.
  const nonDrivingRuns = mergeRuns(norm, (s) => NON_DRIVING_STATUSES.has(s))
  let lastBreakEnd = lastResetEnd
  for (const r of nonDrivingRuns) {
    if (r.start < lastResetEnd || r.start >= nowMs) continue
    // A break still in progress counts from the moment it reaches thirty
    // minutes -- 395.3(a)(3)(ii) asks for thirty consecutive minutes, not
    // for the break to have ended. Clip to now rather than skipping it.
    const end = Math.min(r.end, nowMs)
    if ((end - r.start) / 60000 < BREAK_MINUTES) continue
    if (end > lastBreakEnd) lastBreakEnd = end
  }
  const drivingMinutesSinceLastBreak = sumStatusMinutes(
    norm, lastBreakEnd, nowMs, (s) => s === DUTY_STATUS.DRIVING,
  )
  const breakSatisfied = drivingMinutesSinceLastBreak < BREAK_AFTER_DRIVING_HOURS * 60
  const minutesUntilBreakRequired = Math.max(0, BREAK_AFTER_DRIVING_HOURS * 60 - drivingMinutesSinceLastBreak)

  // -- Weekly limits: on-duty minutes over the trailing 7 or 8 days, capped
  // at the most recent 34-hour restart (395.3(c)) if one happened inside
  // that lookback -- hours from before the restart do not count.
  let restartEnd = null
  for (const r of restRuns) {
    if (r.end <= nowMs && minutesBetween(r) >= RESTART_HOURS * 60) {
      if (restartEnd == null || r.end > restartEnd) restartEnd = r.end
    }
  }
  const window7Start = Math.max(restartEnd ?? -Infinity, nowMs - 7 * 24 * 60 * 60000)
  const window8Start = Math.max(restartEnd ?? -Infinity, nowMs - 8 * 24 * 60 * 60000)
  const dutyMinutesInWindow7Day = sumStatusMinutes(norm, window7Start, nowMs, (s) => ON_DUTY_STATUSES.has(s))
  const dutyMinutesInWindow8Day = sumStatusMinutes(norm, window8Start, nowMs, (s) => ON_DUTY_STATUSES.has(s))
  const dutyMinutesInWindow7DayRemaining = Math.max(0, WEEKLY_LIMIT_HOURS_7DAY * 60 - dutyMinutesInWindow7Day)
  const dutyMinutesInWindow8DayRemaining = Math.max(0, WEEKLY_LIMIT_HOURS_8DAY * 60 - dutyMinutesInWindow8Day)

  // -- Assemble the facts blocking driving, if any. Order is not
  // significance -- a caller wanting "the" reason should not exist; this
  // is a list because more than one can be true at once.
  const limits = []
  if (drivingMinutesRemaining <= 0) {
    limits.push({
      code: 'DRIVING_LIMIT',
      cfr: '395.3(a)(3)',
      detail: `${dutyDuration(drivingMinutesSinceRest)} of the ${DRIVING_LIMIT_HOURS}h allowed driving used since the last qualifying rest.`,
    })
  }
  if (windowMinutesRemaining <= 0) {
    limits.push({
      code: 'DUTY_WINDOW',
      cfr: '395.3(a)(2)',
      detail: `${DUTY_WINDOW_HOURS}-hour duty window elapsed; ${dutyDuration(windowMinutesUsed)} since coming on duty.`,
    })
  }
  if (!breakSatisfied) {
    limits.push({
      code: 'BREAK_REQUIRED',
      cfr: '395.3(a)(3)(ii)',
      detail: `${dutyDuration(drivingMinutesSinceLastBreak)} driving since the last break of ${BREAK_MINUTES}+ minutes; a break is required before driving again.`,
    })
  }
  if (dutyMinutesInWindow7DayRemaining <= 0) {
    limits.push({
      code: 'WEEKLY_60_7',
      cfr: '395.3(b)(1)',
      detail: `${dutyDuration(dutyMinutesInWindow7Day)} on duty of the ${WEEKLY_LIMIT_HOURS_7DAY}h allowed in the trailing 7 days.`,
    })
  }
  if (dutyMinutesInWindow8DayRemaining <= 0) {
    limits.push({
      code: 'WEEKLY_70_8',
      cfr: '395.3(b)(2)',
      detail: `${dutyDuration(dutyMinutesInWindow8Day)} on duty of the ${WEEKLY_LIMIT_HOURS_8DAY}h allowed in the trailing 8 days.`,
    })
  }

  return {
    lastRestEndedAt: lastResetEnd,
    dutyWindowStartedAt,
    windowMinutesRemaining: Math.round(windowMinutesRemaining),
    drivingMinutesSinceRest: Math.round(drivingMinutesSinceRest),
    drivingMinutesRemaining: Math.round(drivingMinutesRemaining),
    lastBreakEndedAt: lastBreakEnd,
    drivingMinutesSinceLastBreak: Math.round(drivingMinutesSinceLastBreak),
    minutesUntilBreakRequired: Math.round(minutesUntilBreakRequired),
    breakSatisfied,
    restartEndedAt: restartEnd,
    dutyMinutesInWindow7Day: Math.round(dutyMinutesInWindow7Day),
    dutyMinutesInWindow7DayRemaining: Math.round(dutyMinutesInWindow7DayRemaining),
    dutyMinutesInWindow8Day: Math.round(dutyMinutesInWindow8Day),
    dutyMinutesInWindow8DayRemaining: Math.round(dutyMinutesInWindow8DayRemaining),
    mayDrive: limits.length === 0,
    limits,
  }
}

// ---------------------------------------------------------------------
// Two clocks: the compressed calendar the database lives on, and the
// literal hours the law is written in
// ---------------------------------------------------------------------
//
// Every timestamp in the database (dispatched_at, eta_at, stop_visits,
// duty_events) is on the compressed calendar -- one simulated day is
// REAL_MS_PER_SIM_DAY real ms (simClock.js). hosState's arithmetic, on the
// other hand, divides milliseconds by 60000 and calls the result minutes:
// it needs LITERAL hours, or "11 hours of driving" would be 27.5 real
// seconds and every limit would be off by the same factor.
//
// HOS_TIME_SCALE is that factor, derived rather than typed: one day's
// worth of literal ms over one day's worth of compressed ms. Converting
// around a fixed anchor (not around 0) keeps the numbers small and makes
// the round trip exact to the millisecond for any anchor.
export const LITERAL_MS_PER_DAY = 24 * 60 * 60 * 1000

// How much of a driver's log every HOS question needs: the 8-day window
// of the 70-hour rule (395.3(b)(2)), plus one full restart's length, so a
// 34-hour restart that ENDED inside the window is read whole instead of
// being cut at the window's edge and looking shorter than it was.
export const HOS_LOOKBACK_HOURS = 8 * 24 + RESTART_HOURS
export const HOS_TIME_SCALE = LITERAL_MS_PER_DAY / REAL_MS_PER_SIM_DAY

export function toHosMs(realMs, anchorMs) {
  return anchorMs + (msOf(realMs) - anchorMs) * HOS_TIME_SCALE
}

export function fromHosMs(hosMs, anchorMs) {
  return anchorMs + Math.round((msOf(hosMs) - anchorMs) / HOS_TIME_SCALE)
}

// Events on the compressed calendar -> the same events in literal hours,
// around anchorMs. An open event (endedAt null) stays open.
export function toHosDomain(events, anchorMs) {
  return (events || []).map((e) => ({
    ...e,
    startedAt: toHosMs(e.startedAt, anchorMs),
    endedAt: e.endedAt == null ? null : toHosMs(e.endedAt, anchorMs),
  }))
}

export function fromHosDomain(events, anchorMs) {
  return (events || []).map((e) => ({
    ...e,
    startedAt: fromHosMs(e.startedAt, anchorMs),
    endedAt: e.endedAt == null ? null : fromHosMs(e.endedAt, anchorMs),
  }))
}

// ---------------------------------------------------------------------
// Gaps are Off Duty
// ---------------------------------------------------------------------
//
// An ELD never has a hole in it: a driver is always in exactly one of the
// four statuses, and a status lasts until the next one is recorded. This
// codebase only writes duty_events for the part of a driver's life that is
// a dispatched run -- between loads nothing is written, and the driver is
// off duty (loads.repository.js's releaseDriver: 'resting'). hosState, by
// design, only counts time it is SHOWN, so a 20-hour gap between two loads
// would otherwise count as neither driving nor rest, and the driver would
// never get their 10-hour reset back. This fills every gap -- between two
// recorded events, and from the last one up to `untilMs` -- with an
// explicit OFF_DUTY event, so the reset is earned by time actually passed.
export function withOffDutyGaps(events, untilMs) {
  const until = msOf(untilMs)
  const norm = normalizeEvents(events, until)
  const out = []
  let cursor = null
  for (const e of norm) {
    if (cursor != null && e.startedAt > cursor) {
      out.push({ status: DUTY_STATUS.OFF_DUTY, startedAt: cursor, endedAt: e.startedAt, filled: true })
    }
    out.push(e)
    cursor = cursor == null ? e.endedAt : Math.max(cursor, e.endedAt)
  }
  if (cursor != null && Number.isFinite(until) && until > cursor) {
    out.push({ status: DUTY_STATUS.OFF_DUTY, startedAt: cursor, endedAt: until, filled: true })
  }
  return out
}

// ---------------------------------------------------------------------
// The four drivers columns, finally with a writer
// ---------------------------------------------------------------------
//
// drivers.hos_remaining_min, hours_today_min and hours_week_min (migration
// 005) had no runtime writer (hos.js's own header). This is the one
// function that derives all three -- plus duty_status -- from a driver's
// duty_events, so the tick can write them and nothing else computes them a
// second, different way.
//
//   hosRemainingMin -- minutes this driver may still DRIVE before any
//     limit stops them: the smallest of the 11-hour driving limit, the
//     14-hour window and both weekly limits. Bounded 0..660 by the same
//     arithmetic migration 005's drivers_hos_range CHECK states.
//   hoursTodayMin   -- on-duty minutes in the CURRENT duty period (since
//     the last qualifying 10-hour rest). A "day" for HOS is the duty
//     period, not the calendar day; it cannot legally exceed the 14-hour
//     window, which is migration 005's drivers_hours_today bound (840).
//   hoursWeekMin    -- on-duty minutes in the trailing 8 days (the 70/8
//     rule, 395.3(b)(2)); bounded by 70h = 4200, drivers_hours_week.
//   dutyStatus      -- the status of whichever event covers nowMs, in the
//     drivers.duty_status vocabulary. null when no recorded event covers
//     now: the caller keeps the column as it is (a driver between loads
//     stays 'resting', a driver HR put 'off' stays 'off').
//
// events and nowMs are on the COMPRESSED calendar (database timestamps);
// the conversion to literal hours happens here, around nowMs.
export function driverHosSnapshot(events, nowRealMs) {
  const nowReal = msOf(nowRealMs)
  // Planned events that have not started yet are passed through as-is:
  // hosState and sumStatusMinutes already clip every sum at nowMs, so a
  // not-yet-happened event contributes nothing (test: "ignores events
  // that have not started yet"). No second filter here pretending to be
  // the thing that makes that true.
  const recorded = normalizeEvents(events, nowReal)
  // The event covering now: started, and either still open (endedAt null
  // -- normalizeEvents has already closed it at nowReal above, so this is
  // read off the raw input) or ending after now.
  const current = (events || []).find((e) => {
    const start = msOf(e.startedAt)
    return start <= nowReal && (e.endedAt == null || nowReal < msOf(e.endedAt))
  }) ?? null

  const hosEvents = withOffDutyGaps(toHosDomain(recorded, nowReal), nowReal)
  const state = hosState(hosEvents, nowReal)

  const hosRemainingMin = Math.max(0, Math.min(
    state.drivingMinutesRemaining,
    state.windowMinutesRemaining,
    state.dutyMinutesInWindow7DayRemaining,
    state.dutyMinutesInWindow8DayRemaining,
  ))
  // The writers of the drivers columns (the tick's syncDriverHos) must stay
  // inside migration 005's bounds: drivers_hours_today caps at the 14-hour
  // window (840), drivers_hours_week at 70 hours (4200). hosState's sums can
  // exceed both: an open event runs until the read (normalizeEvents closes
  // it at now), and a wait written open-ended -- eventBlocks.js's
  // openWaitEndMs, replan.service.js's logOpenEventWait -- stretches 1,130
  // real seconds into 226 literal HOS hours of on-duty time while the
  // dispatcher thinks. The LAW saturates a driver's log the same way (no
  // violation grows past the window that bounds it); without the clamp the
  // write died on drivers_hours_today, found live in the tick log
  // (2026-09-25). mayDrive stays honest: hosState lists the limit that
  // bound (DUTY_WINDOW), so the dispatcher sees why the clock shows full.
  const hoursTodayMin = Math.round(Math.min(
    sumStatusMinutes(
      normalizeEvents(hosEvents, nowReal), state.lastRestEndedAt, nowReal, (s) => ON_DUTY_STATUSES.has(s),
    ),
    DUTY_WINDOW_HOURS * 60,
  ))

  return {
    dutyStatus: current ? DUTY_STATUS_TO_DB_STATUS[current.status] : null,
    eldStatus: current ? current.status : null,
    hosRemainingMin,
    hoursTodayMin,
    hoursWeekMin: Math.round(Math.min(state.dutyMinutesInWindow8Day, WEEKLY_LIMIT_HOURS_8DAY * 60)),
    mayDrive: state.mayDrive,
    limits: state.limits,
  }
}

// ---------------------------------------------------------------------
// Compliance > Driver HOS: the columns a dispatcher's HOS screen shows
// ---------------------------------------------------------------------
//
// Column set and order from the fleet platform's own Hours of Service
// report (https://kb.samsara.com/hc/en-us/articles/360043794691, read
// 2026-09-21): Duty status, Time in current status, Vehicle, Time until
// break, Drive remaining, Shift remaining, Cycle remaining, Cycle
// tomorrow. Every number below comes from hosState -- nothing here
// re-derives a rule.
//
// Cycle = the 70-hour/8-day rule (395.3(b)(2)), the same one
// drivers.hours_week_min tracks. hosState computes 60/7 too and either
// blocks driving (see its header); the screen shows one cycle, as the
// platform does per ruleset.

// How long the driver has been in the status they are in now: back to
// the start of the unbroken run of that same status, in HOS minutes.
// Events in the literal-hours domain. null when no event covers nowMs.
export function timeInCurrentStatusMinutes(events, nowMs) {
  const now = msOf(nowMs)
  const norm = normalizeEvents(events, now)
  const current = norm.find((e) => e.startedAt <= now && now <= e.endedAt && e.endedAt > e.startedAt)
  if (!current) return null
  let start = current.startedAt
  for (let i = norm.length - 1; i >= 0; i -= 1) {
    const e = norm[i]
    if (e.startedAt >= start) continue
    if (e.status !== current.status || e.endedAt < start) break
    start = e.startedAt
  }
  return Math.round((now - start) / 60000)
}

// Cycle hours available at the start of the next day if the driver does
// no more work before then: 70 hours minus the on-duty time that will
// still sit inside the 8 days ending at nextDayStartMs. Only time already
// worked counts (events clipped at nowMs) -- a planned leg that has not
// happened is not yet on the log. A 34-hour restart completed by nowMs
// zeroes everything before it, exactly as in hosState.
export function cycleTomorrowMinutes(events, nowMs, nextDayStartMs) {
  const now = msOf(nowMs)
  const next = msOf(nextDayStartMs)
  const recorded = normalizeEvents(events, now)
    .filter((e) => e.startedAt < now)
    .map((e) => ({ ...e, endedAt: Math.min(e.endedAt, now) }))
  const restRuns = mergeRuns(recorded, (s) => REST_STATUSES.has(s))
  let restartEnd = -Infinity
  for (const r of restRuns) {
    if (r.end <= now && minutesBetween(r) >= RESTART_HOURS * 60 && r.end > restartEnd) restartEnd = r.end
  }
  const windowStart = Math.max(restartEnd, next - 8 * 24 * 60 * 60000)
  const used = sumStatusMinutes(recorded, windowStart, next, (s) => ON_DUTY_STATUSES.has(s))
  return Math.round(Math.max(0, WEEKLY_LIMIT_HOURS_8DAY * 60 - used))
}

// One row of the Driver HOS screen. events and both timestamps are on
// the COMPRESSED calendar (database timestamps); converted here, around
// nowRealMs, exactly as driverHosSnapshot does.
export function driverHosClocks(events, nowRealMs, nextDayStartRealMs) {
  const nowReal = msOf(nowRealMs)
  const hosEvents = withOffDutyGaps(toHosDomain(normalizeEvents(events, nowReal), nowReal), nowReal)
  const state = hosState(hosEvents, nowReal)
  const snap = driverHosSnapshot(events, nowReal)
  return {
    dutyStatus: snap.eldStatus,
    timeInCurrentStatusMin: snap.eldStatus == null ? null : timeInCurrentStatusMinutes(toHosDomain(normalizeEvents(events, nowReal), nowReal), nowReal),
    timeUntilBreakMin: state.minutesUntilBreakRequired,
    driveRemainingMin: state.drivingMinutesRemaining,
    shiftRemainingMin: state.windowMinutesRemaining,
    cycleRemainingMin: state.dutyMinutesInWindow8DayRemaining,
    // null when there is no day boundary to measure to (no company
    // calendar yet -- sim_epoch() has nothing to anchor on).
    cycleTomorrowMin: nextDayStartRealMs == null
      ? null
      : cycleTomorrowMinutes(hosEvents, nowReal, toHosMs(nextDayStartRealMs, nowReal)),
    drivingInViolation: snap.eldStatus === DUTY_STATUS.DRIVING && !state.mayDrive,
    limits: state.limits,
  }
}

// ---------------------------------------------------------------------
// Compliance > HOS Violations: when did driving happen while the law
// said no?
// ---------------------------------------------------------------------
//
// A violation is DRIVING time at a moment hosState(events, t).mayDrive
// is false. Found by walking each driving event forward: at each point,
// hosState says how many minutes are left on the tightest clock; jump
// that far (at least a minute) and ask again. The first point where
// mayDrive is false starts a violation that runs to the end of the
// event -- or until a clock gives time back (only the rolling weekly
// window can, as old days slide out), which the same walk catches.
//
// Every clock and rule is hosState's; this only asks it questions.
// Events in the literal-hours domain; minutes are HOS minutes.

export const VIOLATION_TYPES = Object.freeze({
  DRIVING_LIMIT: { label: '11-Hour Driving Limit', cfr: '395.3(a)(3)' },
  DUTY_WINDOW: { label: '14-Hour Shift Limit', cfr: '395.3(a)(2)' },
  BREAK_REQUIRED: { label: '30-Minute Break', cfr: '395.3(a)(3)(ii)' },
  WEEKLY_60_7: { label: '60-Hour/7-Day Cycle', cfr: '395.3(b)(1)' },
  WEEKLY_70_8: { label: '70-Hour/8-Day Cycle', cfr: '395.3(b)(2)' },
})

const MINUTE_MS = 60000

export function findViolations(events, untilMs) {
  const until = msOf(untilMs)
  const norm = normalizeEvents(events, until)
  const out = []
  for (const e of norm) {
    if (e.status !== DUTY_STATUS.DRIVING) continue
    const end = Math.min(e.endedAt, until)
    let t = e.startedAt
    let open = null
    while (t < end) {
      const st = hosState(norm, t)
      if (!st.mayDrive) {
        const codes = st.limits.map((l) => l.code)
        if (!open) open = { startedAt: t, codes: new Set(codes) }
        else codes.forEach((c) => open.codes.add(c))
        t = Math.min(end, t + MINUTE_MS)
        continue
      }
      if (open) {
        out.push({ ...open, endedAt: t })
        open = null
      }
      const leftMin = Math.min(
        st.drivingMinutesRemaining, st.windowMinutesRemaining, st.minutesUntilBreakRequired,
        st.dutyMinutesInWindow7DayRemaining, st.dutyMinutesInWindow8DayRemaining,
      )
      t = Math.min(end, t + Math.max(1, leftMin) * MINUTE_MS)
    }
    if (open) out.push({ ...open, endedAt: end })
  }
  return out.map((v) => ({
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    minutes: Math.round((v.endedAt - v.startedAt) / MINUTE_MS),
    codes: [...v.codes],
  }))
}

// The same on the COMPRESSED calendar: events as stored, gaps filled as
// Off Duty, only what has happened by nowRealMs. Timestamps come back on
// the compressed calendar; minutes stay HOS minutes.
export function findViolationsReal(events, nowRealMs) {
  const nowReal = msOf(nowRealMs)
  const hosEvents = withOffDutyGaps(toHosDomain(normalizeEvents(events, nowReal), nowReal), nowReal)
  return findViolations(hosEvents, nowReal).map((v) => ({
    ...v,
    startedAt: fromHosMs(v.startedAt, nowReal),
    endedAt: fromHosMs(v.endedAt, nowReal),
  }))
}

// Each test names the one CFR-numbered rule it exists to check, and the
// comment above it says which mutation of the arithmetic it is meant to
// kill -- same convention as test/truckWear.test.js.
//
// Times are built in hours from an arbitrary epoch (HOUR/DAY below) rather
// than real dates, since hosState takes milliseconds and never reads the
// wall clock -- the epoch is just a convenient zero point.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  hosState, restQualifies, splitSleeperPairs, minutesDriving, minutesOnDuty,
  DUTY_STATUS, DUTY_STATUS_TO_DB_STATUS, DB_DUTY_STATUSES,
  DRIVING_LIMIT_HOURS, DUTY_WINDOW_HOURS, BREAK_AFTER_DRIVING_HOURS, BREAK_MINUTES,
  WEEKLY_LIMIT_HOURS_7DAY, WEEKLY_LIMIT_HOURS_8DAY, RESTART_HOURS,
  SLEEPER_BERTH_MIN_HOURS, SLEEPER_OFF_MIN_HOURS, REQUIRED_REST_HOURS,
  restEndsAt,
} from '../src/constants/hosClock.js'

const here = dirname(fileURLToPath(import.meta.url))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// Builds one event from hour offsets, in the ELD status vocabulary.
function ev(status, startH, endH) {
  return { status, startedAt: startH * HOUR, endedAt: endH * HOUR }
}

const { OFF_DUTY, SLEEPER_BERTH, DRIVING, ON_DUTY_NOT_DRIVING } = DUTY_STATUS

// ---------------------------------------------------------------------
// Sanity: the constants are the legal numbers the task exists to fix
// ---------------------------------------------------------------------

test('constants: driving limit is 11, duty window is 14 -- not the same number', () => {
  // THE BUG THIS FILE FIXES: scripts/seed/facilities.js computes
  // DRIVING_HOURS_PER_DAY = 24 - REQUIRED_REST_HOURS = 14 and uses it as a
  // DRIVING cap. 14 is the duty window (395.3(a)(2)); the driving cap is
  // 11 (395.3(a)(3)). If this test ever finds them equal, hosClock.js has
  // been quietly folded back into the same bug it was written to name.
  assert.equal(DRIVING_LIMIT_HOURS, 11)
  assert.equal(DUTY_WINDOW_HOURS, 14)
  assert.notEqual(DRIVING_LIMIT_HOURS, DUTY_WINDOW_HOURS)
})

// ---------------------------------------------------------------------
// 395.3(a)(3) -- 11-hour driving limit
// ---------------------------------------------------------------------

test('395.3(a)(3): 11 hours of driving since the last rest blocks driving, window and break still clear', () => {
  // THE MUTATION: DRIVING_LIMIT_HOURS changed from 11 (e.g. to 14, the
  // facilities.js bug) makes drivingMinutesRemaining stay positive here
  // and this assertion goes red.
  const events = [
    ev(OFF_DUTY, 0, 10), // qualifying 10h rest -- reset at hour 10
    ev(DRIVING, 10, 18), // 8h driving
    ev(ON_DUTY_NOT_DRIVING, 18, 18.5), // a 30-min break -- keeps the break rule clear
    ev(DRIVING, 18.5, 21.5), // 3h more driving: 8 + 3 = 11h total
  ]
  const now = 21.5 * HOUR
  const state = hosState(events, now)

  assert.equal(state.drivingMinutesSinceRest, 11 * 60)
  assert.equal(state.drivingMinutesRemaining, 0)
  assert.equal(state.mayDrive, false)
  assert.deepEqual(state.limits.map((l) => l.code), ['DRIVING_LIMIT'])
  assert.equal(state.limits[0].cfr, '395.3(a)(3)')
})

// ---------------------------------------------------------------------
// 395.3(a)(2) -- 14-hour duty window, distinct from the driving limit
// ---------------------------------------------------------------------

test('395.3(a)(2): the 14-hour window can block driving while driving hours are still available', () => {
  // THE central distinction this file exists to enforce: a driver with
  // driving time left on the 11-hour clock still cannot drive once the
  // 14-hour window since coming on duty has elapsed, because a chunk of
  // that window was spent on-duty-not-driving rather than driving.
  //
  // THE MUTATION: if windowMinutesRemaining were computed from
  // DRIVING_LIMIT_HOURS instead of DUTY_WINDOW_HOURS (i.e. the
  // facilities.js confusion, transplanted into this function), this
  // window would never be seen as exceeded here and mayDrive would
  // wrongly read true.
  const events = [
    ev(OFF_DUTY, 0, 10), // reset at hour 10
    ev(DRIVING, 10, 18), // 8h driving
    ev(ON_DUTY_NOT_DRIVING, 18, 18.5), // 30-min break, keeps break rule clear
    ev(DRIVING, 18.5, 20), // 1.5h more driving -- 9.5h total, driving limit NOT hit
    ev(ON_DUTY_NOT_DRIVING, 20, 24), // 4h on duty, not driving -- burns the window only
  ]
  const now = 24 * HOUR // 14h after the 10h reset: the window, not the driving clock
  const state = hosState(events, now)

  assert.equal(state.drivingMinutesSinceRest, 9.5 * 60)
  assert.ok(state.drivingMinutesRemaining > 0, 'driving clock still has time left')
  assert.equal(state.windowMinutesRemaining, 0)
  assert.equal(state.mayDrive, false)
  assert.deepEqual(state.limits.map((l) => l.code), ['DUTY_WINDOW'])
  assert.equal(state.limits[0].cfr, '395.3(a)(2)')
})

// ---------------------------------------------------------------------
// 395.3(a)(3)(ii) -- the 30-minute break after 8 hours of driving
// ---------------------------------------------------------------------

test('395.3(a)(3)(ii): 8 hours of driving with no break requires one', () => {
  // THE MUTATION: BREAK_AFTER_DRIVING_HOURS changed, or the `<` in
  // breakSatisfied loosened to `<=`, would let this pass at exactly the
  // 8-hour mark instead of requiring the break right then.
  const events = [
    ev(OFF_DUTY, 0, 10),
    ev(DRIVING, 10, 18), // exactly 8h driving, no break at all
  ]
  const state = hosState(events, 18 * HOUR)

  assert.equal(state.drivingMinutesSinceLastBreak, 8 * 60)
  assert.equal(state.breakSatisfied, false)
  assert.equal(state.minutesUntilBreakRequired, 0)
  assert.ok(state.limits.some((l) => l.code === 'BREAK_REQUIRED' && l.cfr === '395.3(a)(3)(ii)'))
  assert.equal(state.mayDrive, false)
})

test('395.3(a)(3)(ii): a 30-minute ON-DUTY-NOT-DRIVING period satisfies the break, not only off duty', () => {
  // The regulation requires 30 minutes not driving -- off duty, sleeper
  // berth, or on-duty-not-driving all count. THE MUTATION: narrowing the
  // break-run predicate to REST_STATUSES only (excluding
  // ON_DUTY_NOT_DRIVING) would make this break not register and
  // breakSatisfied would wrongly stay false.
  const events = [
    ev(OFF_DUTY, 0, 10),
    ev(DRIVING, 10, 18), // 8h driving
    ev(ON_DUTY_NOT_DRIVING, 18, 18.5), // 30 min, NOT off duty
  ]
  const state = hosState(events, 18.5 * HOUR)

  assert.equal(state.breakSatisfied, true)
  assert.equal(state.drivingMinutesSinceLastBreak, 0)
  assert.equal(state.minutesUntilBreakRequired, BREAK_AFTER_DRIVING_HOURS * 60)
  assert.ok(!state.limits.some((l) => l.code === 'BREAK_REQUIRED'))
})

// ---------------------------------------------------------------------
// The 14-hour window does not pause -- only a sleeper-berth split does
// ---------------------------------------------------------------------

test('a break does not pause the 14-hour window', () => {
  // THE MUTATION: computing windowMinutesUsed by subtracting break/
  // non-driving time (i.e. only counting driving+on-duty-not-driving
  // minutes toward the window) would shrink this below 120 and the
  // assertion would go red.
  const events = [
    ev(OFF_DUTY, 0, 10), // reset at hour 10
    ev(DRIVING, 10, 10.5),
    ev(OFF_DUTY, 10.5, 11), // a 30-min break, mid-window
    ev(DRIVING, 11, 12),
  ]
  const state = hosState(events, 12 * HOUR)

  // 2 hours have passed since the window opened at hour 10 -- the 30-min
  // break is INSIDE that elapsed time, not subtracted from it.
  assert.equal(state.windowMinutesRemaining, DUTY_WINDOW_HOURS * 60 - 120)
})

// ---------------------------------------------------------------------
// 395.1(g)(1) -- sleeper-berth split, and the exception that DOES restart
// the window
// ---------------------------------------------------------------------

test('395.1(g)(1): a 7+3 sleeper-berth split qualifies as rest and restarts the 14-hour window', () => {
  // 7h in the sleeper berth (the anchor) plus a separate 3h off-duty
  // period (the partner), totaling exactly 10h, split by driving in
  // between -- one of the two example combinations named in the task
  // (7/3). THE MUTATION: pairing the anchor with its own attached rest
  // run, or requiring strictly MORE than 10h (`<=` instead of `<` in the
  // total check), would make this split fail to register, and
  // lastRestEndedAt / dutyWindowStartedAt would fall back to hour 0
  // instead of hour 12.
  const events = [
    ev(SLEEPER_BERTH, 0, 7), // 7h anchor
    ev(DRIVING, 7, 9), // driving separates the two rest periods
    ev(OFF_DUTY, 9, 12), // 3h partner -- pair completes at hour 12
    ev(DRIVING, 12, 13), // 1h driving after the split
  ]
  const state = hosState(events, 13 * HOUR)

  assert.equal(state.lastRestEndedAt, 12 * HOUR)
  assert.equal(state.dutyWindowStartedAt, 12 * HOUR)
  assert.equal(state.drivingMinutesSinceRest, 60) // only the post-split hour counts
  assert.equal(state.windowMinutesRemaining, DUTY_WINDOW_HOURS * 60 - 60)
  assert.equal(state.mayDrive, true)
})

test('splitSleeperPairs: finds both the 7/3 and 8/2 combinations, and rejects a run that never reaches SLEEPER_BERTH_MIN_HOURS', () => {
  const sevenThree = [
    ev(SLEEPER_BERTH, 0, 7),
    ev(DRIVING, 7, 8),
    ev(OFF_DUTY, 8, 11),
  ]
  assert.equal(splitSleeperPairs(sevenThree).length, 1)

  const eightTwo = [
    ev(SLEEPER_BERTH, 0, 8),
    ev(DRIVING, 8, 9),
    ev(OFF_DUTY, 9, 11),
  ]
  assert.equal(splitSleeperPairs(eightTwo).length, 1)

  // Anchor under 7h (SLEEPER_BERTH_MIN_HOURS): 6h sleeper + 4h off duty is
  // 10h total but the sleeper half never reaches the required minimum, so
  // it is not a valid split.
  const anchorTooShort = [
    ev(SLEEPER_BERTH, 0, 6),
    ev(DRIVING, 6, 7),
    ev(OFF_DUTY, 7, 11),
  ]
  assert.equal(splitSleeperPairs(anchorTooShort).length, 0)
})

test('restQualifies: a plain 10-hour off-duty block qualifies without any split', () => {
  assert.equal(restQualifies([ev(OFF_DUTY, 0, REQUIRED_REST_HOURS)]), true)
  assert.equal(restQualifies([ev(OFF_DUTY, 0, REQUIRED_REST_HOURS - 1)]), false)
})

// ---------------------------------------------------------------------
// 395.3(b) -- the weekly 60/7 and 70/8 limits, which count ON-DUTY hours
// ---------------------------------------------------------------------

test('395.3(b): 70 hours on duty in 8 days blocks driving even with a fresh daily window and driving clock', () => {
  // Seven straight days of a 10-hour on-duty (not driving) period followed
  // by a 14-hour off-duty reset. No driving anywhere in this log, so the
  // 11-hour and 14-hour DAILY clocks are untouched -- only the rolling
  // weekly total is what stops this driver.
  //
  // THE MUTATION: computing the weekly totals from minutesDriving instead
  // of minutesOnDuty (i.e. ignoring on-duty-not-driving time, as
  // dutyMinutesInWindow7Day/8Day must not) would read 0 on-duty minutes
  // here and mayDrive would wrongly stay true.
  const events = []
  for (let day = 0; day < 7; day += 1) {
    events.push(ev(ON_DUTY_NOT_DRIVING, day * 24, day * 24 + 10))
    events.push(ev(OFF_DUTY, day * 24 + 10, (day + 1) * 24))
  }
  const now = 7 * DAY // right after day 6's rest ends; day 7 has not started
  const state = hosState(events, now)

  assert.equal(state.dutyMinutesInWindow7Day, 70 * 60)
  assert.equal(state.dutyMinutesInWindow7DayRemaining, 0)
  assert.equal(state.dutyMinutesInWindow8Day, 70 * 60)
  assert.equal(state.dutyMinutesInWindow8DayRemaining, 0)
  // The daily clocks are untouched -- full window and full driving time.
  assert.equal(state.windowMinutesRemaining, DUTY_WINDOW_HOURS * 60)
  assert.equal(state.drivingMinutesRemaining, DRIVING_LIMIT_HOURS * 60)
  assert.equal(state.mayDrive, false)
  assert.ok(state.limits.some((l) => l.code === 'WEEKLY_70_8' && l.cfr === '395.3(b)(2)'))
})

test('395.3(c): 34 consecutive hours off duty restarts the weekly count', () => {
  // Same seven days of 70 on-duty hours as above, but followed by a
  // qualifying 34-hour restart. THE MUTATION: comparing restart duration
  // against REQUIRED_REST_HOURS (10) instead of RESTART_HOURS (34), or
  // dropping the `Math.max(restartEnd, ...)` floor on the weekly window
  // start, would leave the pre-restart 70 hours counted and this would
  // stay blocked.
  const events = []
  for (let day = 0; day < 7; day += 1) {
    events.push(ev(ON_DUTY_NOT_DRIVING, day * 24, day * 24 + 10))
    events.push(ev(OFF_DUTY, day * 24 + 10, (day + 1) * 24))
  }
  const restartStartH = 7 * 24
  const restartEndH = restartStartH + RESTART_HOURS + 1 // 35h, comfortably over the 34h floor
  events.push(ev(OFF_DUTY, restartStartH, restartEndH))

  const now = restartEndH * HOUR
  const state = hosState(events, now)

  assert.equal(state.restartEndedAt, now)
  assert.equal(state.dutyMinutesInWindow7Day, 0)
  assert.equal(state.dutyMinutesInWindow7DayRemaining, WEEKLY_LIMIT_HOURS_7DAY * 60)
  assert.equal(state.dutyMinutesInWindow8Day, 0)
  assert.equal(state.dutyMinutesInWindow8DayRemaining, WEEKLY_LIMIT_HOURS_8DAY * 60)
  assert.equal(state.mayDrive, true)
})

// ---------------------------------------------------------------------
// Multiple limits at once
// ---------------------------------------------------------------------

test('limits lists every blocking rule at once, not just one', () => {
  // 11 hours of continuous driving with zero break trips the driving
  // limit. To also trip the window without accidentally SATISFYING the
  // break requirement (a single non-driving stretch of 30+ minutes would
  // count as a qualifying break, clearing that limit going forward), the
  // remaining 3 hours to reach the 14-hour window are spent as six
  // 25-minute on-duty-not-driving spells, each interrupted by 5 minutes of
  // driving -- never a single non-driving run reaches BREAK_MINUTES.
  // events are built in minutes here (not the ev() hour helper) so the
  // block boundaries are exact integers, not floating-point hour
  // fractions.
  const evMin = (status, startMin, endMin) => (
    { status, startedAt: startMin * 60000, endedAt: endMin * 60000 }
  )
  const events = [
    evMin(OFF_DUTY, 0, 600), // 10h rest
    evMin(DRIVING, 600, 1260), // 11h straight, no break
  ]
  for (let i = 0; i < 6; i += 1) {
    const base = 1260 + i * 30
    events.push(evMin(ON_DUTY_NOT_DRIVING, base, base + 25)) // 25 min -- under BREAK_MINUTES
    events.push(evMin(DRIVING, base + 25, base + 30)) // 5 min driving -- breaks the non-driving run
  }
  const now = 1440 * 60000 // 24h: 14h since the 10h reset

  const state = hosState(events, now)

  assert.equal(state.windowMinutesRemaining, 0)
  assert.equal(state.drivingMinutesRemaining, 0)
  assert.equal(state.breakSatisfied, false)
  assert.equal(state.mayDrive, false)
  const codes = state.limits.map((l) => l.code).sort()
  assert.deepEqual(codes, ['BREAK_REQUIRED', 'DRIVING_LIMIT', 'DUTY_WINDOW'])
})

// ---------------------------------------------------------------------
// A driver who has never worked
// ---------------------------------------------------------------------

test('an empty event log is not an error -- a driver who has not worked yet may drive', () => {
  const state = hosState([], Date.UTC(2026, 0, 1))
  assert.equal(state.mayDrive, true)
  assert.deepEqual(state.limits, [])
  assert.equal(state.drivingMinutesRemaining, DRIVING_LIMIT_HOURS * 60)
  assert.equal(state.windowMinutesRemaining, DUTY_WINDOW_HOURS * 60)
  assert.equal(state.dutyWindowStartedAt, null)
})

test('hosState accepts Date objects for events and now, not only milliseconds', () => {
  const base = Date.UTC(2026, 0, 1)
  const events = [
    { status: OFF_DUTY, startedAt: new Date(base), endedAt: new Date(base + 10 * HOUR) },
    { status: DRIVING, startedAt: new Date(base + 10 * HOUR), endedAt: new Date(base + 11 * HOUR) },
  ]
  const state = hosState(events, new Date(base + 11 * HOUR))
  assert.equal(state.drivingMinutesSinceRest, 60)
  assert.equal(state.mayDrive, true)
})

// ---------------------------------------------------------------------
// minutesDriving / minutesOnDuty
// ---------------------------------------------------------------------

test('minutesDriving and minutesOnDuty clip to the requested window and ignore other statuses', () => {
  const events = [
    ev(OFF_DUTY, 0, 1),
    ev(DRIVING, 1, 3), // 2h driving
    ev(ON_DUTY_NOT_DRIVING, 3, 4), // 1h on duty, not driving
  ]
  assert.equal(minutesDriving(events, 0, 4 * HOUR), 2 * 60)
  assert.equal(minutesOnDuty(events, 0, 4 * HOUR), 3 * 60) // driving + on-duty-not-driving
  // Clipped to a sub-window: only the first hour of the 2h driving block.
  assert.equal(minutesDriving(events, 0, 2 * HOUR), 60)
})

// ---------------------------------------------------------------------
// duty_status mapping -- pinned against the db migration, the same way
// test/truckWear.test.js pins DAILY_DISTANCE_CAP_MI against migration 009
// ---------------------------------------------------------------------

test('DB_DUTY_STATUSES matches the drivers_duty_status CHECK in migration 005_drivers.sql', () => {
  const migrationPath = join(here, '../src/db/migrations/005_drivers.sql')
  const sql = readFileSync(migrationPath, 'utf8')
  const match = sql.match(/drivers_duty_status\s+CHECK\s*\(duty_status IN \(([^)]+)\)\)/)
  assert.ok(match, 'expected to find the drivers_duty_status CHECK in the migration')
  const dbValues = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  assert.deepEqual([...dbValues].sort(), [...DB_DUTY_STATUSES].sort())
})

test('DUTY_STATUS_TO_DB_STATUS maps every ELD status to a value the migration allows', () => {
  for (const eldStatus of Object.values(DUTY_STATUS)) {
    const dbValue = DUTY_STATUS_TO_DB_STATUS[eldStatus]
    assert.ok(DB_DUTY_STATUSES.includes(dbValue), `${eldStatus} -> ${dbValue} is not a valid drivers.duty_status`)
  }
})

// ---------------------------------------------------------------------
// Open events -- the driver's CURRENT status has no end yet
// ---------------------------------------------------------------------
//
// A real ELD log always ends in one open event: whatever the driver is
// doing right now. Every test above uses closed events only, which is how
// a normalizer that silently dropped open events (isFinite(endedAt)) got
// past all of them. These three are the ones that would have caught it.

function open(status, startH) {
  return { status, startedAt: startH * HOUR, endedAt: null }
}

test('open event: a driving stint still in progress counts toward the 11 hours', () => {
  // THE MUTATION: normalizeEvents dropping events whose endedAt is null.
  // Then the live six hours vanish, drivingMinutesSinceRest reads 0, and
  // a driver six hours into a run looks fresh.
  const events = [
    ev(OFF_DUTY, 0, 10),
    open(DRIVING, 10),
  ]
  const s = hosState(events, 16 * HOUR)
  assert.equal(s.drivingMinutesSinceRest, 6 * 60)
  assert.equal(s.drivingMinutesRemaining, (DRIVING_LIMIT_HOURS - 6) * 60)
})

test('open event: an in-progress drive past 11 hours blocks driving right now', () => {
  // The case that matters on the road: the limit is crossed DURING the
  // current stint, not after it ends. Dropping the open event makes this
  // driver legal to keep going.
  const events = [
    ev(OFF_DUTY, 0, 10),
    open(DRIVING, 10),
  ]
  const s = hosState(events, 21.5 * HOUR)
  assert.equal(s.mayDrive, false)
  assert.ok(s.limits.some((l) => l.code === 'DRIVING_LIMIT'))
})

test('open event: a break still in progress satisfies 395.3(a)(3)(ii) once it reaches 30 minutes', () => {
  // THE MUTATION: the break loop skipping any run whose end is past now
  // (r.end > nowMs). A driver forty minutes into a break would then still
  // read as owing one. Thirty consecutive minutes is the rule -- the break
  // does not have to have ENDED.
  const events = [
    ev(OFF_DUTY, 0, 10),
    ev(DRIVING, 10, 18),          // 8h: break now required
    open(OFF_DUTY, 18),           // break started at 18:00, still going
  ]
  const at40min = hosState(events, 18 * HOUR + 40 * 60 * 1000)
  assert.equal(at40min.breakSatisfied, true)
  assert.ok(!at40min.limits.some((l) => l.code === 'BREAK_REQUIRED'))

  // And not a minute early: twenty minutes in, the break is not yet done.
  const at20min = hosState(events, 18 * HOUR + 20 * 60 * 1000)
  assert.equal(at20min.breakSatisfied, false)
})

test('open event: a rest still in progress is NOT yet a qualifying 10-hour rest', () => {
  // restQualifies and splitSleeperPairs ask about COMPLETED rests. An open
  // off-duty event must not count there -- the driver is resting, not
  // rested. Guards the other half of the openEndMs contract.
  const events = [
    ev(DRIVING, 0, 8),
    open(OFF_DUTY, 8),
  ]
  assert.equal(restQualifies(events), false)
})

// ---------------------------------------------------------------------
// Stage 2 -- the compressed calendar, gaps, and the drivers columns
// ---------------------------------------------------------------------

import {
  HOS_TIME_SCALE, LITERAL_MS_PER_DAY, toHosMs, fromHosMs, toHosDomain, fromHosDomain,
  withOffDutyGaps, driverHosSnapshot,
} from '../src/constants/hosClock.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

// One literal hour on the compressed calendar the database lives on.
const REAL_HOUR = REAL_MS_PER_SIM_DAY / 24
function rev(status, startH, endH, anchor = 0) {
  return { status, startedAt: anchor + startH * REAL_HOUR, endedAt: endH == null ? null : anchor + endH * REAL_HOUR }
}

// Kills: a hand-typed scale, or one inverted (REAL/LITERAL instead of LITERAL/REAL).
test('HOS_TIME_SCALE turns one compressed simulated day into one literal day', () => {
  assert.equal(REAL_MS_PER_SIM_DAY * HOS_TIME_SCALE, LITERAL_MS_PER_DAY)
  assert.equal(toHosMs(1000 + REAL_HOUR, 1000) - 1000, HOUR)
})

// Kills: converting around 0 instead of the anchor, or a lossy inverse.
test('toHosMs/fromHosMs round-trip exactly around any anchor', () => {
  const anchor = Date.UTC(2026, 8, 21, 12, 0, 0)
  for (const t of [anchor, anchor + 1, anchor + 12345, anchor - 99999, anchor + 7 * REAL_MS_PER_SIM_DAY]) {
    assert.equal(fromHosMs(toHosMs(t, anchor), anchor), t)
  }
  const evs = [rev(DUTY_STATUS.DRIVING, 0, 3, anchor), rev(DUTY_STATUS.OFF_DUTY, 3, null, anchor)]
  assert.deepEqual(fromHosDomain(toHosDomain(evs, anchor), anchor), evs)
  assert.equal(toHosDomain(evs, anchor)[1].endedAt, null, 'an open event stays open')
})

// Kills: dropping the gap fill (a between-loads gap counting as nothing),
// or filling with an on-duty status.
test('withOffDutyGaps turns an unrecorded gap into Off Duty, so a 10-hour gap resets the driver', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 11), ev(DUTY_STATUS.DRIVING, 22, 23)]
  const filled = withOffDutyGaps(evs, 23 * HOUR)
  const gap = filled.find((e) => e.filled)
  assert.equal(gap.status, DUTY_STATUS.OFF_DUTY)
  assert.equal(gap.startedAt, 11 * HOUR)
  assert.equal(gap.endedAt, 22 * HOUR)
  assert.equal(hosState(evs, 23 * HOUR).mayDrive, false, 'without the fill the 11 hours never reset')
  assert.equal(hosState(filled, 23 * HOUR).mayDrive, true, 'with it, the 11-hour gap is a real 10-hour rest')
})

// Kills: not extending the trailing fill up to "now".
test('withOffDutyGaps fills from the last event up to now', () => {
  const filled = withOffDutyGaps([ev(DUTY_STATUS.DRIVING, 0, 11)], 21 * HOUR)
  assert.equal(filled.at(-1).status, DUTY_STATUS.OFF_DUTY)
  assert.equal(filled.at(-1).endedAt, 21 * HOUR)
  assert.equal(hosState(filled, 21 * HOUR).mayDrive, true)
})

// Kills: mapping ELD Off Duty to 'off' (the invisible-driver bug).
test('ELD Off Duty maps to resting, never to off', () => {
  assert.equal(DUTY_STATUS_TO_DB_STATUS[DUTY_STATUS.OFF_DUTY], 'resting')
})

// Kills: snapshot reading literal ms straight off compressed timestamps
// (every limit 720x too loose), or hosRemainingMin ignoring the window.
test('driverHosSnapshot: 6 compressed hours of driving leaves 300 minutes', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [rev(DUTY_STATUS.DRIVING, 0, null, anchor)]
  const snap = driverHosSnapshot(evs, anchor + 6 * REAL_HOUR)
  assert.equal(snap.dutyStatus, 'driving')
  assert.equal(snap.hosRemainingMin, 300)
  assert.equal(snap.hoursTodayMin, 360)
  assert.equal(snap.hoursWeekMin, 360)
  assert.equal(snap.mayDrive, true)
})

// Kills: taking only the driving limit (the window here is the binding one).
test('driverHosSnapshot: the 14-hour window binds before the 11-hour limit when on-duty time burns it', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [
    rev(DUTY_STATUS.ON_DUTY_NOT_DRIVING, 0, 6, anchor),
    rev(DUTY_STATUS.DRIVING, 6, 10, anchor),
  ]
  const snap = driverHosSnapshot(evs, anchor + 10 * REAL_HOUR)
  // driving left 7h = 420; window left 4h = 240
  assert.equal(snap.hosRemainingMin, 240)
  assert.equal(snap.hoursTodayMin, 600)
})

// Kills: counting planned future events as already recorded.
test('driverHosSnapshot ignores events that have not started yet', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [rev(DUTY_STATUS.DRIVING, 0, 2, anchor), rev(DUTY_STATUS.DRIVING, 5, 16, anchor)]
  const snap = driverHosSnapshot(evs, anchor + 3 * REAL_HOUR)
  assert.equal(snap.hosRemainingMin, 540)
  assert.equal(snap.dutyStatus, null, 'no recorded event covers now -- the caller keeps the column')
})

// Kills: a between-loads gap not resetting the snapshot.
test('driverHosSnapshot: a long gap after a run gives the full 660 back', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [rev(DUTY_STATUS.DRIVING, 0, 11, anchor)]
  assert.equal(driverHosSnapshot(evs, anchor + 11 * REAL_HOUR).hosRemainingMin, 0)
  const later = driverHosSnapshot(evs, anchor + 22 * REAL_HOUR)
  assert.equal(later.hosRemainingMin, 660)
  assert.equal(later.hoursTodayMin, 0)
  assert.equal(later.hoursWeekMin, 660)
})

test('driverHosSnapshot with no events is a full, rested clock', () => {
  const snap = driverHosSnapshot([], Date.UTC(2026, 8, 21))
  assert.deepEqual(
    [snap.dutyStatus, snap.hosRemainingMin, snap.hoursTodayMin, snap.hoursWeekMin],
    [null, 660, 0, 0],
  )
})

// Kills: the snapshot writing past migration 005's column bounds
// (drivers_hours_today 840, drivers_hours_week 4200) -- an open-ended wait
// row (eventBlocks.js openWaitEndMs, written by replan.service.js's
// logOpenEventWait while the dispatcher is deciding) stretches real seconds
// into days of literal on-duty time, and the drivers_hours_today CHECK
// rejected the tick's write outright (found live, 2026-09-25). The law
// saturates the log at the window that bounds it; the columns do too.
test('driverHosSnapshot saturates at the 14h/70h column bounds on an open-ended wait', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [rev(DUTY_STATUS.ON_DUTY_NOT_DRIVING, 0, null, anchor)]
  // Thirty compressed DAYS into an on-duty wait nobody has ended -- 720
  // literal HOS hours on duty, far past every bound. The columns
  // saturate; the reason travels with the snapshot.
  const snap = driverHosSnapshot(evs, anchor + 30 * REAL_MS_PER_SIM_DAY)
  assert.equal(snap.hoursTodayMin, DUTY_WINDOW_HOURS * 60)
  assert.equal(snap.hoursWeekMin, WEEKLY_LIMIT_HOURS_8DAY * 60)
  assert.equal(snap.hosRemainingMin, 0)
  assert.equal(snap.mayDrive, false)
  assert.ok(snap.limits.some((l) => l.code === 'DUTY_WINDOW'), 'the reason travels with the snapshot')
})

// The clamp above is only correct while its two constants ARE the column
// bounds. Nothing said so: the saturation test asserts the snapshot
// against DUTY_WINDOW_HOURS and WEEKLY_LIMIT_HOURS_8DAY, and migration
// 005 asserts nothing at all -- so raising either constant, or editing
// the CHECK, would put the tick back on the failure the clamp was added
// for, with every test still green.
//
// Read from the migration the same way DB_DUTY_STATUSES is, two tests
// below.
//
// Kills: the constants and the CHECK drifting apart in either direction.
test('the snapshot clamps are exactly migration 005\'s column bounds', () => {
  const sql = readFileSync(join(here, '../src/db/migrations/005_drivers.sql'), 'utf8')
  const bound = (name) => {
    const m = sql.match(new RegExp(`${name}\\s+CHECK\\s*\\([^)]*BETWEEN\\s+0\\s+AND\\s+(\\d+)`))
    assert.ok(m, `expected to find the ${name} CHECK in migration 005`)
    return Number(m[1])
  }
  assert.equal(DUTY_WINDOW_HOURS * 60, bound('drivers_hours_today'))
  assert.equal(WEEKLY_LIMIT_HOURS_8DAY * 60, bound('drivers_hours_week'))
})

// Kills: the ELD status vocabulary and migration 037's CHECK drifting apart.
test('duty_events status CHECK (037) allows exactly the four ELD statuses', () => {
  const sql = readFileSync(join(here, '../src/db/migrations/037_duty_events.sql'), 'utf8')
  const match = sql.match(/duty_events_status\s+CHECK\s*\(\s*status IN \(([^)]+)\)/)
  assert.ok(match, 'expected to find the duty_events_status CHECK in migration 037')
  const dbValues = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  assert.deepEqual([...dbValues].sort(), [...Object.values(DUTY_STATUS)].sort())
})

// ---------------------------------------------------------------------
// Compliance > Driver HOS columns
// ---------------------------------------------------------------------
import { timeInCurrentStatusMinutes, cycleTomorrowMinutes, driverHosClocks } from '../src/constants/hosClock.js'

// Kills: counting only the latest event instead of the unbroken run.
test('timeInCurrentStatus runs back through adjacent events of the same status', () => {
  const evs = [ev(DUTY_STATUS.ON_DUTY_NOT_DRIVING, 0, 1), ev(DUTY_STATUS.DRIVING, 1, 3), ev(DUTY_STATUS.DRIVING, 3, 5)]
  assert.equal(timeInCurrentStatusMinutes(evs, 4 * HOUR), 180)
})

// Kills: running back through a different status.
test('timeInCurrentStatus stops at a status change', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 2), ev(DUTY_STATUS.OFF_DUTY, 2, 3), ev(DUTY_STATUS.DRIVING, 3, 5)]
  assert.equal(timeInCurrentStatusMinutes(evs, 4 * HOUR), 60)
  assert.equal(timeInCurrentStatusMinutes(evs, 6 * HOUR), null)
})

// Kills: using now - 8 days instead of next-day-start - 8 days (the day
// that drops off tomorrow must come back).
test('cycleTomorrow gives back the day that leaves the 8-day window at the next day start', () => {
  // 10h on duty 8 days ago (day -8, hours 0-10), 10h yesterday.
  const evs = [ev(DUTY_STATUS.DRIVING, -8 * 24, -8 * 24 + 10), ev(DUTY_STATUS.DRIVING, -24, -14)]
  const now = 0
  const nextDay = 24 * HOUR
  // Today's cycle: both days inside the trailing 8 days -> 70 - 20h.
  assert.equal(hosState(evs, now).dutyMinutesInWindow8DayRemaining, 50 * 60)
  // Tomorrow the day -8 block is outside [next-8d, next) -> 70 - 10h.
  assert.equal(cycleTomorrowMinutes(evs, now, nextDay), 60 * 60)
})

// Kills: counting planned (not yet worked) time toward tomorrow's cycle.
test('cycleTomorrow ignores planned time after now', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 5), ev(DUTY_STATUS.DRIVING, 6, 16)]
  assert.equal(cycleTomorrowMinutes(evs, 5 * HOUR, 24 * HOUR), 65 * 60)
})

// Kills: ignoring a completed 34-hour restart.
test('cycleTomorrow: a completed 34-hour restart resets the cycle', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, -60, -50), ev(DUTY_STATUS.OFF_DUTY, -50, -10), ev(DUTY_STATUS.DRIVING, -10, -5)]
  assert.equal(cycleTomorrowMinutes(evs, 0, 24 * HOUR), 65 * 60)
})

// End to end on the compressed calendar.
test('driverHosClocks: 3 compressed hours into a drive after 1h on duty', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const evs = [rev(DUTY_STATUS.ON_DUTY_NOT_DRIVING, 0, 1, anchor), rev(DUTY_STATUS.DRIVING, 1, null, anchor)]
  const now = anchor + 4 * REAL_HOUR
  const c = driverHosClocks(evs, now, anchor + 24 * REAL_HOUR)
  assert.equal(c.dutyStatus, DUTY_STATUS.DRIVING)
  assert.equal(c.timeInCurrentStatusMin, 180)
  assert.equal(c.timeUntilBreakMin, 300)
  assert.equal(c.driveRemainingMin, 480)
  assert.equal(c.shiftRemainingMin, 600)
  assert.equal(c.cycleRemainingMin, 70 * 60 - 240)
  assert.equal(c.cycleTomorrowMin, 70 * 60 - 240)
  assert.equal(c.drivingInViolation, false)
})

// Kills: drivingInViolation never set (or set for a non-driving status).
test('driverHosClocks flags driving past the 11-hour limit, and only while driving', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const driving = driverHosClocks([rev(DUTY_STATUS.DRIVING, 0, null, anchor)], anchor + 12 * REAL_HOUR, anchor + 24 * REAL_HOUR)
  assert.equal(driving.drivingInViolation, true)
  assert.ok(driving.limits.some((l) => l.code === 'DRIVING_LIMIT'))
  const resting = driverHosClocks([rev(DUTY_STATUS.DRIVING, 0, 12, anchor), rev(DUTY_STATUS.OFF_DUTY, 12, null, anchor)], anchor + 13 * REAL_HOUR, anchor + 24 * REAL_HOUR)
  assert.equal(resting.drivingInViolation, false)
})

// ---------------------------------------------------------------------
// HOS Violations
// ---------------------------------------------------------------------
import { findViolations, findViolationsReal, VIOLATION_TYPES } from '../src/constants/hosClock.js'

// Kills: no violation detection at all, or starting it at the event start.
test('findViolations: 12 hours of straight driving is a violation from the 8th hour', () => {
  const v = findViolations([ev(DUTY_STATUS.DRIVING, 0, 12)], 12 * HOUR)
  assert.equal(v.length, 1)
  assert.equal(v[0].startedAt, 8 * HOUR, 'the 30-minute break was due at hour 8')
  assert.equal(v[0].endedAt, 12 * HOUR)
  assert.equal(v[0].minutes, 240)
  assert.ok(v[0].codes.includes('BREAK_REQUIRED'))
  assert.ok(v[0].codes.includes('DRIVING_LIMIT'), 'the 11-hour limit joins it at hour 11')
})

// Kills: flagging legal driving.
test('findViolations: a legal day (8h, 30m break, 3h) has none', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 8), ev(DUTY_STATUS.OFF_DUTY, 8, 8.5), ev(DUTY_STATUS.DRIVING, 8.5, 11.5)]
  assert.deepEqual(findViolations(evs, 12 * HOUR), [])
})

// Kills: only checking the 8-hour break (the 11-hour limit alone).
test('findViolations: driving an 11th-plus hour after a legal break is a DRIVING_LIMIT violation', () => {
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 8), ev(DUTY_STATUS.OFF_DUTY, 8, 8.5), ev(DUTY_STATUS.DRIVING, 8.5, 12.5)]
  const v = findViolations(evs, 13 * HOUR)
  assert.equal(v.length, 1)
  assert.equal(v[0].startedAt, 11.5 * HOUR)
  assert.deepEqual(v[0].codes, ['DRIVING_LIMIT'])
})

// Kills: counting non-driving time past a limit (being on duty after 14h
// is legal; only driving is not).
test('findViolations: on-duty (not driving) past the 14-hour window is not a violation', () => {
  const evs = [ev(DUTY_STATUS.ON_DUTY_NOT_DRIVING, 0, 16)]
  assert.deepEqual(findViolations(evs, 16 * HOUR), [])
})

// Kills: ignoring `until` (counting planned driving).
test('findViolations stops at until', () => {
  const v = findViolations([ev(DUTY_STATUS.DRIVING, 0, 12)], 9 * HOUR)
  assert.equal(v[0].endedAt, 9 * HOUR)
})

test('findViolationsReal returns compressed-calendar timestamps and HOS minutes', () => {
  const anchor = Date.UTC(2026, 8, 21)
  const v = findViolationsReal([rev(DUTY_STATUS.DRIVING, 0, 12, anchor)], anchor + 13 * REAL_HOUR)
  assert.equal(v.length, 1)
  assert.equal(v[0].startedAt, anchor + 8 * REAL_HOUR)
  assert.equal(v[0].minutes, 240)
})

test('every limit code hosState can report has a violation type', () => {
  for (const code of ['DRIVING_LIMIT', 'DUTY_WINDOW', 'BREAK_REQUIRED', 'WEEKLY_60_7', 'WEEKLY_70_8']) {
    assert.ok(VIOLATION_TYPES[code], code)
  }
  const src = readFileSync(join(here, '../src/constants/hosClock.js'), 'utf8')
  const emitted = new Set([...src.matchAll(/code: '([A-Z0-9_]+)',\n\s+cfr:/g)].map((m) => m[1]))
  for (const code of emitted) assert.ok(VIOLATION_TYPES[code], `${code} has no violation type`)
})

// Kills: jumping past a clock that has only minutes left (the violation
// must start at the exact minute the break came due, not an hour later).
test('findViolations starts a violation at the exact minute, even when only minutes were left', () => {
  // 7h45m driving, a 15-minute stop (not a qualifying break), then driving.
  const evs = [ev(DUTY_STATUS.DRIVING, 0, 7.75), ev(DUTY_STATUS.OFF_DUTY, 7.75, 8), ev(DUTY_STATUS.DRIVING, 8, 10)]
  const v = findViolations(evs, 10 * HOUR)
  assert.equal(v.length, 1)
  assert.equal(v[0].startedAt, 8.25 * HOUR)
  assert.deepEqual(v[0].codes, ['BREAK_REQUIRED'])
})

// Kills: 038 drifting from the ELD annotation rule (4..60 characters) or
// losing the "no driver only for unidentified, and then a truck" rule.
test('038 enforces annotation length 4..60 and unidentified-only null driver', () => {
  const sql = readFileSync(join(here, '../src/db/migrations/038_duty_events_eld_fields.sql'), 'utf8')
  assert.match(sql, /char_length\(btrim\(annotation\)\) BETWEEN 4 AND 60/)
  assert.match(sql, /annotation IS NULL OR char_length\(annotation\) <= 60/)
  assert.match(sql, /driver_id IS NOT NULL\s+OR \(origin = 'unidentified' AND truck_id IS NOT NULL\)/)
  const sql037 = readFileSync(join(here, '../src/db/migrations/037_duty_events.sql'), 'utf8')
  assert.match(sql037, /'unidentified'/, '037 must already allow the unidentified origin 038 relies on')
})

// --- when the current ten ends -------------------------------------------

// Kills: ending the rest at the wrong time (rest length not read from REQUIRED_REST_HOURS, or not converted back to the compressed calendar)
test('a rest that began when driving ended is up REQUIRED_REST_HOURS later on the HOS clock', () => {
  const T = 1000 * HOUR
  const now = T + 5 * 60 * 1000
  const events = [{ status: DUTY_STATUS.DRIVING, startedAt: T - 4 * HOUR, endedAt: T }]
  const expected = fromHosMs(toHosMs(T, now) + REQUIRED_REST_HOURS * HOUR, now)
  assert.equal(restEndsAt(events, now).getTime(), expected)
})

// Kills: inventing a rest end for a driver who is not resting or has no log
test('no log, or a driver still driving, has no rest end', () => {
  const now = 1000 * HOUR
  assert.equal(restEndsAt([], now), null)
  assert.equal(restEndsAt([{ status: DUTY_STATUS.DRIVING, startedAt: now - HOUR, endedAt: null }], now), null)
})

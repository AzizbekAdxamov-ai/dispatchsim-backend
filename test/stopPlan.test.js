// facilities/stopPlan.js: where a load stops on the way, and why.
//
// Pure function, no DB -- see stopPlan.js's own header on why. Every test
// here builds its own tiny synthetic route (never a real city pair) so the
// numbers are exact and hand-checkable, the same reason truckWear.test.js
// never touches the real fleet data either.
//
// Route geometry trick used throughout: a straight line ALONG THE EQUATOR
// (lat = 0 for every point) has an EXACT closed-form length -- haversineMi
// between two equatorial points collapses to
// EARTH_RADIUS_MI * (delta-longitude in radians), no sin/cos left over --
// so `lonAtOffsetMi(mi)` below places a point at EXACTLY `mi` real miles
// from the origin, and a whole scenario's mileage is then arithmetic, not
// approximation. `MI_PER_DEG_LON` is measured through the module's own
// haversineMi() rather than a hardcoded Earth radius, so these tests keep
// working even if that constant is ever retuned.
//
// THE REWRITE THIS FILE TESTS: planStops no longer walks a fixed-mileage
// rest cadence and cuts anything that would land past etaAt. It runs one
// forward simulation against hosClock.js's own hosState(), and never drops
// a legally-required rest or break -- see stopPlan.js's own header. Tests
// below therefore check the LEGAL outcome (a duty-cycle fact, a stop
// count, a machine-checked hosState().mayDrive), never a truncation.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planStops, projectOntoRoute } from '../src/modules/facilities/stopPlan.js'
import { AVG_MPG } from '../src/modules/finance/finance.constants.js'
import { DAILY_DRIVE_MI, SPACING_MI } from '../scripts/seed/facilities.js'
import {
  hosState, DRIVING_LIMIT_HOURS, REQUIRED_REST_HOURS, BREAK_MINUTES,
} from '../src/constants/hosClock.js'
import { simDaysToMs } from '../src/constants/simClock.js'
import { haversineMi } from '../scripts/seed/cities.js'

const MI_PER_DEG_LON = haversineMi({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })
function lonAtOffsetMi(mi) {
  return mi / MI_PER_DEG_LON
}
// [lon, lat] pair at `mi` real miles east of the equatorial origin --
// OSRM's own coordinate order, the shape routeGeometry is always in.
function pt(mi) {
  return [lonAtOffsetMi(mi), 0]
}

const DISPATCHED_AT = '2026-01-01T00:00:00.000Z'
const FULL_TANK_GAL = 240 // trucks.fuel_capacity_gal's own DEFAULT (006)
// Big enough that no route under 2000mi ever needs a fuel stop -- used by
// tests that care only about the HOS/duty-cycle side, not fuel.
const NO_FUEL_STOP_TANK_GAL = 300
// stopPlan.js's own FUEL_RESERVE_MI = SPACING_MI (facilities.js) -- reused
// here, not retyped, so a usable-range calc in one test can never drift
// from the constant the module itself uses.
const FUEL_RESERVE_MI = SPACING_MI

function facility({ id, kind = 'truck_stop', offsetMi, fuelPriceCents = 399 }) {
  return { id, kind, name: id, lat: 0, lon: lonAtOffsetMi(offsetMi), fuelPriceCents, amenities: [] }
}

// Evenly-spaced facilities across [0, distanceMi), every `spacing` miles --
// dense enough that a legally-required stop almost always lands on a real
// one instead of the shoulder, so a test can assert on `stops` (the
// facility-backed, DB-shaped list) rather than only on dutyTimeline.
function denseFacilities(distanceMi, spacing) {
  const out = []
  for (let m = spacing; m < distanceMi; m += spacing) out.push(facility({ id: `f${m}`, offsetMi: m }))
  return out
}

function restDurationsHours(dutyTimeline) {
  return dutyTimeline
    .filter((e) => e.status === 'off-duty')
    .map((e) => (new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 3600000)
}

// ---------------------------------------------------------------------
// 0. DAILY_DRIVE_MI is the fixed bug: 11 hours, not 14.
// ---------------------------------------------------------------------
test('DAILY_DRIVE_MI is DRIVING_LIMIT_HOURS (11) times 55mph -- 605, never 14h/770mi', () => {
  assert.equal(DAILY_DRIVE_MI, 605)
  assert.equal(DRIVING_LIMIT_HOURS, 11)
})

// ---------------------------------------------------------------------
// 1. A short route needs nothing at all -- under the 8h break threshold,
//    the 11h driving limit, the 14h window and the tank's own range.
// ---------------------------------------------------------------------
test('a route well under every HOS clock and the tank range has no stops at all', () => {
  const distanceMi = 300 // < 8h*55mph=440mi (break), < DAILY_DRIVE_MI, < tank range
  const { stops, dutyTimeline, hosFacts, warnings, legalArrivalAt } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
  })
  assert.deepEqual(stops, [])
  assert.deepEqual(hosFacts, [])
  assert.deepEqual(warnings, [])
  assert.equal(dutyTimeline.length, 1)
  assert.equal(dutyTimeline[0].status, 'driving')
  assert.ok(new Date(legalArrivalAt).getTime() > new Date(DISPATCHED_AT).getTime())
})

// ---------------------------------------------------------------------
// 2. A long route's fuel stop sits BEFORE the tank's reach limit, not
//    past it -- kept under the 8h break threshold so this test is about
//    fuel range alone.
// ---------------------------------------------------------------------
test("a fuel stop sits before the tank's reach limit, not past it, and needs no HOS stop of its own", () => {
  const startFuelGallons = 60
  const fuelCapacityGal = 60
  const usableRangeMi = startFuelGallons * AVG_MPG - FUEL_RESERVE_MI
  const distanceMi = usableRangeMi + 50 // just far enough that a stop is required
  assert.ok(distanceMi < 440, 'test setup: must stay under the 8h break threshold')
  const stopOffsetMi = 150
  assert.ok(stopOffsetMi < usableRangeMi, 'test setup: candidate must be reachable on the starting tank')

  const { stops, warnings } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons,
    fuelCapacityGal,
    facilities: [facility({ id: 'f1', kind: 'fuel', offsetMi: stopOffsetMi })],
    dispatchedAt: DISPATCHED_AT,
  })

  assert.equal(stops.length, 1)
  assert.equal(stops[0].reason, 'fuel')
  assert.equal(stops[0].routeOffsetMi, stopOffsetMi)
  // THE MUTATION this kills: dropping "- FUEL_RESERVE_MI" from the usable
  // range calc widens it past the point a stop is even needed here.
  assert.ok(stops[0].routeOffsetMi < usableRangeMi)
  assert.deepEqual(warnings, [])
})

// ---------------------------------------------------------------------
// 3. Gallons purchased and their cost follow the SAME shape
//    truckWear.js's fuelCostForGallons uses: round(gallons * price),
//    just against the facility's OWN price instead of the fleet-wide
//    constant.
// ---------------------------------------------------------------------
test('fuel stop cost follows fuelCostForGallons-style rounding, against the facility price', () => {
  const startFuelGallons = 50
  const fuelCapacityGal = 50
  const stopOffsetMi = 100
  const usableRangeMi = startFuelGallons * AVG_MPG - FUEL_RESERVE_MI
  const distanceMi = usableRangeMi + 50
  assert.ok(distanceMi < 440, 'test setup: must stay under the 8h break threshold')
  const fuelPriceCents = 399 // $3.99/gal

  const { stops } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons,
    fuelCapacityGal,
    facilities: [facility({ id: 'f1', kind: 'fuel', offsetMi: stopOffsetMi, fuelPriceCents })],
    dispatchedAt: DISPATCHED_AT,
  })

  const fuelStop = stops.find((s) => s.reason === 'fuel')
  assert.ok(fuelStop)
  const gallonsAtArrival = startFuelGallons - stopOffsetMi / AVG_MPG
  const expectedGallons = Math.max(1, Math.round(fuelCapacityGal - gallonsAtArrival))
  assert.equal(fuelStop.gallons, expectedGallons)
  const expectedCostUsd = Math.round(expectedGallons * (fuelPriceCents / 100))
  assert.equal(fuelStop.costUsd, expectedCostUsd)
  // THE MUTATION this kills: dropping the "/100" (treating fuelPriceCents
  // as though it were already dollars) inflates costUsd by 100x.
})

// ---------------------------------------------------------------------
// 4. The 605/606 boundary: 49 CFR 395.3(a)(3), 11 hours of driving at
//    55mph. A break still happens at the 8h mark either way (that clock
//    is independent of the driving limit) -- what this test pins is the
//    10-HOUR RESET, which must appear starting at 606mi and not before.
// ---------------------------------------------------------------------
test('605mi needs no 10-hour reset; 606mi needs exactly one', () => {
  const facilitiesFor = (distanceMi) => denseFacilities(distanceMi, 5)

  const at605 = planStops({
    routeGeometry: [pt(0), pt(605)],
    distanceMi: 605,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: facilitiesFor(605),
    dispatchedAt: DISPATCHED_AT,
  })
  const at606 = planStops({
    routeGeometry: [pt(0), pt(606)],
    distanceMi: 606,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: facilitiesFor(606),
    dispatchedAt: DISPATCHED_AT,
  })

  // A 10-hour reset is an off-duty block of at least REQUIRED_REST_HOURS;
  // the 30-minute break (also off-duty, at the independent 8h mark) is
  // well short of it -- this is what tells the two apart, not a count of
  // "off-duty" events, which both routes have from the break alone.
  const resets605 = restDurationsHours(at605.dutyTimeline).filter((h) => h >= REQUIRED_REST_HOURS)
  const resets606 = restDurationsHours(at606.dutyTimeline).filter((h) => h >= REQUIRED_REST_HOURS)
  assert.equal(resets605.length, 0, 'THE MUTATION this kills: using 14h instead of 11h would add a reset far too early, or none at all at the true 11h edge')
  assert.equal(resets606.length, 1)
  assert.equal(resets606[0], REQUIRED_REST_HOURS)

  assert.ok(!at605.hosFacts.some((f) => f.code === 'DRIVING_LIMIT'))
  assert.ok(at606.hosFacts.some((f) => f.code === 'DRIVING_LIMIT'))
})

// ---------------------------------------------------------------------
// 5. A fuel stop that lands exactly where the 30-minute break comes due
//    (8h of driving, 395.3(a)(3)(ii)) is STRETCHED to cover it -- no
//    second, separate break stop is ever added alongside it.
// ---------------------------------------------------------------------
test('a fuel stop at the 8-hour break point absorbs the break; no separate break is added', () => {
  // Tank sized so the truck's forced fuel stop lands AT 440mi -- exactly
  // 8 driving-hours (395.3(a)(3)(ii)'s own BREAK_AFTER_DRIVING_HOURS) at
  // AVG_HIGHWAY_MPH's 55mph.
  const breakAtMi = 8 * 55
  const fuelCapacityGal = (breakAtMi + FUEL_RESERVE_MI) / AVG_MPG
  const distanceMi = 500
  const { stops, dutyTimeline, hosFacts, warnings } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: fuelCapacityGal,
    fuelCapacityGal,
    facilities: [facility({ id: 'f1', kind: 'fuel', offsetMi: breakAtMi })],
    dispatchedAt: DISPATCHED_AT,
  })

  assert.deepEqual(warnings, [])
  assert.equal(stops.length, 1)
  assert.equal(stops[0].reason, 'fuel')
  assert.equal(stops[0].routeOffsetMi, breakAtMi)

  const onDutyNotDriving = dutyTimeline.filter((e) => e.status === 'on-duty-not-driving')
  const offDuty = dutyTimeline.filter((e) => e.status === 'off-duty')
  assert.equal(onDutyNotDriving.length, 1, 'the fuel stop itself')
  // THE MUTATION this kills: if the break were added as a SEPARATE stop
  // instead of stretching the fuel one, this would be 1, not 0.
  assert.equal(offDuty.length, 0)

  const fuelDurationMin = (new Date(onDutyNotDriving[0].endedAt) - new Date(onDutyNotDriving[0].startedAt)) / 60000
  assert.ok(fuelDurationMin >= BREAK_MINUTES, `fuel stop (${fuelDurationMin}min) must cover the ${BREAK_MINUTES}-minute break`)

  assert.ok(hosFacts.some((f) => f.code === 'FUEL_STOP' && f.detail.includes('break')))
})

// ---------------------------------------------------------------------
// 6. The 14-hour duty window (395.3(a)(2)) can close before the 11-hour
//    driving limit does -- lots of short forced fuel stops eat into the
//    window without adding much DRIVING time. Whichever clock runs out
//    FIRST is the one that triggers the reset.
// ---------------------------------------------------------------------
test('the 14-hour duty window can close before the 11-hour driving limit -- the tighter clock wins', () => {
  // A tank just barely wider than the reserve: every refuel buys back
  // only a few miles, so MANY short fuel stops are needed, and their
  // on-duty-not-driving time (which the window does NOT pause for --
  // hosClock.js's own header) adds up faster than actual driving does.
  const fuelCapacityGal = (3.05 + FUEL_RESERVE_MI) / AVG_MPG
  const distanceMi = 700
  const facilities = denseFacilities(distanceMi, 0.5)
  const { hosFacts, dutyTimeline, warnings } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: fuelCapacityGal,
    fuelCapacityGal,
    facilities,
    dispatchedAt: DISPATCHED_AT,
  })

  const windowFact = hosFacts.find((f) => f.code === 'DUTY_WINDOW')
  assert.ok(windowFact, `expected a DUTY_WINDOW fact; got ${JSON.stringify(hosFacts.map((f) => f.code))}`)
  assert.ok(!hosFacts.some((f) => f.code === 'DRIVING_LIMIT'),
    'THE MUTATION this kills: if the window check were dropped (or never compared against the driving-limit cap), this run would drive straight through 14 hours on duty and only ever cite DRIVING_LIMIT, or nothing at all')

  // The reset this fact describes must have happened with LESS than
  // DRIVING_LIMIT_HOURS of actual driving behind it -- proof the window,
  // not the driving clock, is what actually closed first.
  const resetIdx = dutyTimeline.findIndex((e, i) => (
    e.status === 'off-duty'
    && (new Date(e.endedAt) - new Date(e.startedAt)) / 3600000 >= REQUIRED_REST_HOURS
    && dutyTimeline.slice(0, i).every((prior) => prior.status !== 'off-duty' || (new Date(prior.endedAt) - new Date(prior.startedAt)) / 3600000 < REQUIRED_REST_HOURS)
  ))
  assert.ok(resetIdx > -1, 'expected a 10-hour reset in dutyTimeline')
  const drivingBeforeReset = dutyTimeline.slice(0, resetIdx)
    .filter((e) => e.status === 'driving')
    .reduce((sum, e) => sum + (new Date(e.endedAt) - new Date(e.startedAt)) / 3600000, 0)
  assert.ok(drivingBeforeReset < DRIVING_LIMIT_HOURS,
    `expected under ${DRIVING_LIMIT_HOURS}h of driving before the window-triggered reset, got ${drivingBeforeReset}h`)
  assert.deepEqual(warnings, [])
})

// ---------------------------------------------------------------------
// 7. No facility anywhere in the corridor for a legally required rest --
//    the plan still stops (on the shoulder), and says so. It is never
//    silently dropped for lack of a place to park.
// ---------------------------------------------------------------------
test('a mandatory rest with no facility in the corridor still happens, and says so', () => {
  const distanceMi = 606 // needs a 10-hour reset (test 4)
  const { stops, dutyTimeline, hosFacts, warnings, legalArrivalAt } = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [], // nothing anywhere on this route
    dispatchedAt: DISPATCHED_AT,
  })

  // THE MUTATION this kills: dropping a stop for lack of a facility (the
  // bug this whole rewrite exists to remove) would make `stops` the only
  // place a rest could ever be recorded -- with none here, that mutation
  // reads as "no rest happened at all". dutyTimeline says otherwise.
  assert.deepEqual(stops, [], 'no facility exists, so no stop_visits-shaped row can reference one')
  const resets = restDurationsHours(dutyTimeline).filter((h) => h >= REQUIRED_REST_HOURS)
  assert.equal(resets.length, 1, 'the reset is still IN the plan')
  assert.ok(warnings.some((w) => w.code === 'no-facility-for-rest'))
  assert.ok(hosFacts.some((f) => f.code === 'DRIVING_LIMIT' && f.detail.includes('no facility')))
  // legalArrivalAt still accounts for the full reset time even though no
  // stop_visits row backs it -- compared on the SAME compressed clock
  // legalArrivalAt itself is on (stopPlan.js's own "two clocks" header):
  // a driving-only estimate for this distance, converted through
  // simClock.js's own simDaysToMs exactly as stopPlan.js converts real
  // HOS hours, must be measurably shorter than the actual legal arrival.
  const drivingOnlyHours = distanceMi / 55
  const drivingOnlyMs = new Date(DISPATCHED_AT).getTime() + simDaysToMs(drivingOnlyHours / 24)
  assert.ok(new Date(legalArrivalAt).getTime() > drivingOnlyMs,
    `expected legalArrivalAt (${legalArrivalAt}) after the driving-only estimate (${new Date(drivingOnlyMs).toISOString()})`)
})

// ---------------------------------------------------------------------
// 8. A broker's promised window shorter than the legal transit time is
//    a FACT (legalArrivalAt > promisedEtaAt), never a reason to cut
//    anything out of the plan.
// ---------------------------------------------------------------------
test("a broker window shorter than the legal plan doesn't drop anything -- it's a fact, not a cutoff", () => {
  const distanceMi = 606
  const promisedEtaAt = new Date(new Date(DISPATCHED_AT).getTime() + 1000).toISOString() // absurdly short
  const withPromise = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: denseFacilities(distanceMi, 5),
    dispatchedAt: DISPATCHED_AT,
    promisedEtaAt,
  })
  const withoutPromise = planStops({
    routeGeometry: [pt(0), pt(distanceMi)],
    distanceMi,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: denseFacilities(distanceMi, 5),
    dispatchedAt: DISPATCHED_AT,
  })

  // THE MUTATION this kills: an old etaAt-truncation reading would make
  // `stops`/`dutyTimeline` shrink once promisedEtaAt is added. They must
  // be identical either way -- the promise is compared, never enforced.
  assert.deepEqual(withPromise.stops, withoutPromise.stops)
  assert.deepEqual(withPromise.dutyTimeline, withoutPromise.dutyTimeline)
  assert.equal(withPromise.legalArrivalAt, withoutPromise.legalArrivalAt)

  assert.ok(new Date(withPromise.legalArrivalAt).getTime() > new Date(promisedEtaAt).getTime())
  const lateFact = withPromise.hosFacts.find((f) => f.code === 'LATE_VS_PROMISED')
  assert.ok(lateFact)
  assert.ok(!withoutPromise.hosFacts.some((f) => f.code === 'LATE_VS_PROMISED'), 'no promise given, nothing to compare against')
})

// ---------------------------------------------------------------------
// 9. Machine proof: hosState(dutyTimeline, t).mayDrive is true at the
//    START of every driving segment the plan schedules, for several
//    route lengths. This is the plan's own legality, checked the same
//    way a caller checking "may this driver drive right now" would.
// ---------------------------------------------------------------------
test('every driving segment in the plan starts with hosState().mayDrive === true', () => {
  for (const distanceMi of [50, 439, 605, 606, 1300, 2500]) {
    const facilities = denseFacilities(distanceMi, 5)
    const { dutyTimeline, warnings } = planStops({
      routeGeometry: [pt(0), pt(distanceMi)],
      distanceMi,
      startFuelGallons: 40,
      fuelCapacityGal: 40,
      facilities,
      dispatchedAt: DISPATCHED_AT,
    })
    let drivingSegments = 0
    for (const event of dutyTimeline) {
      if (event.status !== 'driving') continue
      drivingSegments += 1
      const t = new Date(event.startedAt).getTime()
      const state = hosState(dutyTimeline, t)
      assert.ok(state.mayDrive,
        `${distanceMi}mi route: hosState says NOT mayDrive at the start of a driving segment (${event.startedAt}) -- blocked by ${JSON.stringify(state.limits)}`)
    }
    assert.ok(drivingSegments > 0, `${distanceMi}mi route produced no driving at all`)
    assert.ok(warnings.every((w) => w.code !== 'stop-limit-reached'), `${distanceMi}mi route hit the stop-count safety cap`)
  }
})

// ---------------------------------------------------------------------
// 10. route_offset_mi is computed by walking real distance along the
//     polyline, never by "which vertex index is this" -- projectOntoRoute
//     itself (unit-level), and once more end to end through planStops.
// ---------------------------------------------------------------------
test('projectOntoRoute measures real distance, not vertex position', () => {
  // Deliberately uneven segments: 5mi, then 500mi. A vertex-index-based
  // fraction (e.g. treating vertex 1 of 2 as "halfway") would place a
  // point sitting AT vertex 1 around 252mi in; real-distance walking
  // places it at the 5mi it actually is.
  const geometry = [pt(0), pt(5), pt(505)]
  const { offsetMi, perpMi } = projectOntoRoute(geometry, { lat: 0, lon: lonAtOffsetMi(5) })
  assert.ok(perpMi < 0.01, 'the probe point sits exactly on the route')
  assert.ok(Math.abs(offsetMi - 5) < 0.01, `expected ~5mi, got ${offsetMi}`)
  assert.ok(offsetMi < 100, 'must not have landed at the index-based ~252mi midpoint')
})

test('a stop on an unevenly-spaced polyline gets the correct real-distance offset', () => {
  // 200mi then 100mi, uneven, kept under the 8h break threshold so the
  // only stop in play is the fuel one this test is actually checking.
  const distanceMi = 300
  const geometry = [pt(0), pt(200), pt(distanceMi)]
  const stopOffsetMi = 200
  const fuelCapacityGal = (250 + FUEL_RESERVE_MI) / AVG_MPG // usable range 250mi: reaches the candidate, not the end
  const { stops } = planStops({
    routeGeometry: geometry,
    distanceMi,
    startFuelGallons: fuelCapacityGal,
    fuelCapacityGal,
    facilities: [facility({ id: 'f1', kind: 'fuel', offsetMi: stopOffsetMi })],
    dispatchedAt: DISPATCHED_AT,
  })
  assert.equal(stops.length, 1)
  assert.equal(stops[0].routeOffsetMi, stopOffsetMi)
})

// ---------------------------------------------------------------------
// 11. The driver's own earlier runs (priorDutyEvents, 037) carry into
//     this one -- on the compressed calendar, converted by hosClock.js.
// ---------------------------------------------------------------------
import { toHosDomain, withOffDutyGaps, fromHosDomain } from '../src/constants/hosClock.js'

const REAL_HOUR_MS = simDaysToMs(1) / 24
const dispatchedMs = new Date(DISPATCHED_AT).getTime()
// A prior event `endH` compressed hours BEFORE dispatch, lasting `lenH`.
function priorDriving(startBeforeH, endBeforeH) {
  return {
    status: 'driving',
    startedAt: new Date(dispatchedMs - startBeforeH * REAL_HOUR_MS).toISOString(),
    endedAt: new Date(dispatchedMs - endBeforeH * REAL_HOUR_MS).toISOString(),
  }
}

// Kills: priorDutyEvents ignored (fresh 11 hours every load), or the
// owed rest computed as a full 10h instead of 10h minus the rest already
// taken.
test('a driver who just ran 11 hours starts this run with the rest they still owe, as a fact', () => {
  // Drove 11h, finished 4 compressed hours before this dispatch -> owes 6h.
  const { dutyTimeline, hosFacts, warnings } = planStops({
    routeGeometry: [pt(0), pt(100)],
    distanceMi: 100,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: [priorDriving(15, 4)],
  })
  assert.equal(dutyTimeline[0].status, 'off-duty')
  assert.equal(restDurationsHours(dutyTimeline)[0], REQUIRED_REST_HOURS - 4)
  assert.equal(dutyTimeline[1].status, 'driving')
  assert.ok(hosFacts.some((f) => f.code === 'DRIVING_LIMIT' && /Carried over/.test(f.detail)))
  assert.ok(!warnings.some((w) => w.code === 'unexpected-hos-block'), 'a carried-over limit is not a planning bug')
})

// Kills: gaps not treated as rest (a long-rested driver blocked anyway).
test('a driver whose last run ended more than 10 hours ago starts driving immediately', () => {
  const { dutyTimeline, hosFacts } = planStops({
    routeGeometry: [pt(0), pt(100)],
    distanceMi: 100,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: [priorDriving(22, 11)],
  })
  assert.equal(dutyTimeline.length, 1)
  assert.equal(dutyTimeline[0].status, 'driving')
  assert.deepEqual(hosFacts, [])
})

// Kills: prior events leaking into THIS run's dutyTimeline (they would be
// written to duty_events a second time).
test("dutyTimeline holds this run only, never the prior history it was planned against", () => {
  const { dutyTimeline } = planStops({
    routeGeometry: [pt(0), pt(100)],
    distanceMi: 100,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: [priorDriving(30, 25), priorDriving(15, 4)],
  })
  for (const e of dutyTimeline) {
    assert.ok(new Date(e.startedAt).getTime() >= dispatchedMs, `${e.startedAt} is before dispatch`)
  }
})

// Machine proof across loads: prior history + this run together, back on
// the compressed calendar, still never has the driver driving while
// hosState says no.
test('prior history plus the planned run is legal at every driving start', () => {
  const prior = [priorDriving(40, 32), priorDriving(15, 4)]
  const { dutyTimeline } = planStops({
    routeGeometry: [pt(0), pt(1300)],
    distanceMi: 1300,
    startFuelGallons: 40,
    fuelCapacityGal: 40,
    facilities: denseFacilities(1300, 5),
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: prior,
  })
  const run = fromHosDomain(dutyTimeline.map((e) => ({
    ...e, startedAt: new Date(e.startedAt).getTime(), endedAt: new Date(e.endedAt).getTime(),
  })), dispatchedMs)
  const all = [...prior.map((e) => ({ ...e, startedAt: new Date(e.startedAt).getTime(), endedAt: new Date(e.endedAt).getTime() })), ...run]
  for (const e of run) {
    if (e.status !== 'driving') continue
    const hos = withOffDutyGaps(toHosDomain(all, dispatchedMs), toHosDomainPoint(e.startedAt))
    const state = hosState(hos, toHosDomainPoint(e.startedAt))
    assert.ok(state.mayDrive, `blocked at ${new Date(e.startedAt).toISOString()}: ${JSON.stringify(state.limits)}`)
  }
})
function toHosDomainPoint(realMs) {
  return toHosDomain([{ startedAt: realMs, endedAt: realMs + 1 }], dispatchedMs)[0].startedAt
}

// Stationary events carry where they happened, for duty_events.
test('stationary duty events carry their route offset and facility', () => {
  const { dutyTimeline } = planStops({
    routeGeometry: [pt(0), pt(700)],
    distanceMi: 700,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: denseFacilities(700, 5),
    dispatchedAt: DISPATCHED_AT,
  })
  const stationary = dutyTimeline.filter((e) => e.status !== 'driving')
  assert.ok(stationary.length > 0)
  for (const e of stationary) {
    assert.ok(Number.isInteger(e.routeOffsetMi) && e.routeOffsetMi > 0, JSON.stringify(e))
    assert.ok(typeof e.facilityId === 'string', JSON.stringify(e))
  }
})

// Kills: padding a sub-minute HOS clock with MIN_STEP_MI (driving up to a
// minute past the 8-hour line) instead of stopping early for the break.
test('with under a minute left before the 8-hour break, the run starts with the break, not a minute of driving', () => {
  // 479.7 driving minutes, ending exactly at dispatch.
  const prior = [{
    status: 'driving',
    startedAt: new Date(dispatchedMs - (479.7 / 60) * REAL_HOUR_MS).toISOString(),
    endedAt: DISPATCHED_AT,
  }]
  const { dutyTimeline, hosFacts } = planStops({
    routeGeometry: [pt(0), pt(100)],
    distanceMi: 100,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: prior,
  })
  assert.equal(dutyTimeline[0].status, 'off-duty')
  assert.equal(restDurationsHours(dutyTimeline)[0], BREAK_MINUTES / 60)
  assert.ok(hosFacts.some((f) => f.code === 'BREAK_REQUIRED'))
})

// Kills: leaving the 60/70-hour weekly clocks out of the per-leg cap.
test('a driver 36 minutes short of both weekly limits drives at most 36 minutes before the 34-hour restart', () => {
  // Six legal days of 9.9h driving then 14.1h off (59.4h in the trailing
  // 7 days), plus one 10h day eight days back (69.4h in the trailing 8).
  // The last day ends 14h before dispatch, so the daily clocks are fresh
  // and ONLY the weekly ones bind: 36 minutes left on each.
  const prior = [priorDriving(24 * 7 + 12, 24 * 7 + 2)]
  for (let d = 6; d >= 1; d -= 1) {
    const endBefore = (d - 1) * 24 + 14
    prior.push(priorDriving(endBefore + 9.9, endBefore))
  }
  const { dutyTimeline } = planStops({
    routeGeometry: [pt(0), pt(600)],
    distanceMi: 600,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL,
    fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: [],
    dispatchedAt: DISPATCHED_AT,
    priorDutyEvents: prior,
  })
  let drivenMin = 0
  let restarted = false
  for (const e of dutyTimeline) {
    const min = (new Date(e.endedAt) - new Date(e.startedAt)) / 60000
    if (e.status === 'off-duty' && min >= 34 * 60) { restarted = true; break }
    if (e.status === 'driving') drivenMin += min
  }
  assert.ok(restarted, 'expected a 34-hour restart')
  assert.ok(drivenMin > 0, 'the 36 minutes that are left may be used')
  assert.ok(drivenMin <= 36 + 1e-6, `drove ${drivenMin} minutes, past the weekly limit`)
})

// Kills: a warning code added to stopPlan.js with no sentence behind it --
// it would reach the load's stop_plan_facts as a bare code.
import { readFileSync } from 'node:fs'
import { describeWarning } from '../src/modules/facilities/stopPlan.js'
test('every warning code stopPlan.js can emit has a readable sentence', () => {
  const src = readFileSync(new URL('../src/modules/facilities/stopPlan.js', import.meta.url), 'utf8')
  const body = src.slice(0, src.indexOf('export function describeWarning'))
  const codes = new Set([
    ...[...body.matchAll(/warnings\.push\(\{ code: '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...body.matchAll(/empty\('([a-z-]+)'\)/g)].map((m) => m[1]),
  ])
  assert.ok(codes.size >= 8, `found only ${[...codes].join(', ')}`)
  for (const code of codes) {
    const text = describeWarning({ code, atOffsetMi: 1, afterMi: 1, stopCount: 1, atMi: 1 })
    assert.ok(!text.startsWith('Planner warning:'), `${code} has no sentence`)
  }
})

// ---------------------------------------------------------------------
// 12. Re-planning after a road event
// ---------------------------------------------------------------------
import { drivenMilesBefore, sliceRouteFrom } from '../src/modules/facilities/stopPlan.js'
import { dutyStatusDuring, EVENT_TYPES } from '../src/constants/loadEvents.js'
import { fromHosDomain as fromHos } from '../src/constants/hosClock.js'

// Kills: reading compressed ms as HOS ms (720x too few miles), or
// counting non-driving time as distance.
test('drivenMilesBefore: the plan says 2 hours of driving before the event -> 110 miles', () => {
  const { dutyTimeline } = planStops({
    routeGeometry: [pt(0), pt(700)], distanceMi: 700,
    startFuelGallons: NO_FUEL_STOP_TANK_GAL, fuelCapacityGal: NO_FUEL_STOP_TANK_GAL,
    facilities: denseFacilities(700, 5), dispatchedAt: DISPATCHED_AT,
  })
  const real = fromHos(dutyTimeline.map((e) => ({ ...e, startedAt: new Date(e.startedAt).getTime(), endedAt: new Date(e.endedAt).getTime() })), dispatchedMs)
  const twoHours = dispatchedMs + 2 * REAL_HOUR_MS
  assert.ok(Math.abs(drivenMilesBefore(real, twoHours) - 110) < 0.01)
  // After the 8-hour break point the break's 30 minutes add no miles.
  const all = drivenMilesBefore(real, dispatchedMs + 30 * REAL_HOUR_MS)
  assert.ok(Math.abs(all - 700) < 0.5, `whole run drove ${all} mi`)
})

// Kills: slicing by vertex index instead of real distance, or dropping
// the interpolated start point.
test('sliceRouteFrom starts at the exact point, by real distance', () => {
  const geom = [pt(0), pt(10), pt(100)]
  const sliced = sliceRouteFrom(geom, 0.5)
  assert.ok(Math.abs(sliced[0][0] - lonAtOffsetMi(50)) < 1e-9)
  assert.deepEqual(sliced.slice(1), [pt(100)])
  assert.deepEqual(sliceRouteFrom(geom, 0), geom)
})

// Kills: a mapping that misses an option (a delay with no duty status
// would be a hole in the log).
test('every road-event option has a duty status for its delay', () => {
  for (const [type, def] of Object.entries(EVENT_TYPES)) {
    for (const o of def.options) {
      assert.ok(dutyStatusDuring(type, o.key), `${type}.${o.key} has no duty status`)
    }
  }
  assert.equal(dutyStatusDuring('breakdown', 'roadside'), 'on-duty-not-driving', '395.2: attending a disabled CMV is on duty')
  assert.equal(dutyStatusDuring('detention', 'wait'), 'on-duty-not-driving', '395.2: waiting to be loaded is on duty')
  assert.equal(dutyStatusDuring('weather', 'reroute'), 'driving')
})

// The whole re-plan chain, on the compressed calendar, the way
// hos/replan.service.js composes it: plan -> cut at the event -> delay as
// its duty status -> plan the rest with everything before as prior.
import { findViolationsReal, driverHosSnapshot } from '../src/constants/hosClock.js'

function realTimeline(plan, anchorMs) {
  return fromHos(plan.dutyTimeline.map((e) => ({ ...e, startedAt: new Date(e.startedAt).getTime(), endedAt: new Date(e.endedAt).getTime() })), anchorMs)
}
function replanChain({ eventAfterRealH, delayH, delayStatus }) {
  const distanceMi = 900
  const base = { routeGeometry: [pt(0), pt(distanceMi)], startFuelGallons: NO_FUEL_STOP_TANK_GAL, fuelCapacityGal: NO_FUEL_STOP_TANK_GAL }
  const first = realTimeline(planStops({ ...base, distanceMi, facilities: denseFacilities(distanceMi, 5), dispatchedAt: DISPATCHED_AT }), dispatchedMs)
  const eventMs = dispatchedMs + eventAfterRealH * REAL_HOUR_MS
  const kept = first.filter((e) => e.startedAt < eventMs).map((e) => ({ ...e, endedAt: Math.min(e.endedAt, eventMs) }))
  const delay = { status: delayStatus, startedAt: eventMs, endedAt: eventMs + delayH * REAL_HOUR_MS }
  const driven = drivenMilesBefore(first, eventMs)
  const rest = planStops({
    ...base,
    routeGeometry: sliceRouteFrom(base.routeGeometry, driven / distanceMi),
    distanceMi: distanceMi - driven,
    facilities: denseFacilities(distanceMi, 5),
    dispatchedAt: new Date(delay.endedAt).toISOString(),
    priorDutyEvents: [...kept, delay].map((e) => ({ ...e, startedAt: new Date(e.startedAt).toISOString(), endedAt: new Date(e.endedAt).toISOString() })),
  })
  return { log: [...kept, delay, ...realTimeline(rest, delay.endedAt)], driven, rest }
}

// Kills: the delay not being on the log (clocks blind to it), or the
// remainder planned as if the delay did not count.
test('a 3-hour detour after 9 hours of driving: the detour itself is the violation, and the remainder starts with the rest it now needs', () => {
  const { log, rest } = replanChain({ eventAfterRealH: 9.5, delayH: 3, delayStatus: 'driving' })
  // 8h drive + 30m break + 1h drive = 9h driven by the event; +3h detour = 12h > 11.
  const v = findViolationsReal(log, dispatchedMs + 60 * REAL_HOUR_MS)
  assert.equal(v.length, 1, JSON.stringify(v))
  assert.ok(v[0].codes.includes('DRIVING_LIMIT'))
  assert.equal(v[0].minutes, 60, 'one hour of the detour ran past the 11-hour limit')
  assert.equal(rest.dutyTimeline[0].status, 'off-duty', 'the remainder opens with the owed rest')
})

// Kills: counting a breakdown's attendance as rest.
test('a 9-hour roadside repair is on duty: it burns the 14-hour shift, it does not reset it', () => {
  const { log, driven } = replanChain({ eventAfterRealH: 2, delayH: 9, delayStatus: 'on-duty-not-driving' })
  assert.ok(Math.abs(driven - 110) < 0.01)
  const afterRepair = dispatchedMs + 11 * REAL_HOUR_MS
  const snap = driverHosSnapshot(log, afterRepair)
  // 2h driving + 9h on duty = 11h into the 14-hour shift -> 3h left.
  assert.equal(snap.hosRemainingMin, 180)
  assert.deepEqual(findViolationsReal(log, dispatchedMs + 60 * REAL_HOUR_MS), [], 'the re-planned remainder is legal')
})

// Kills: the log having a hole or an overlap where the plan was cut.
test('the re-planned log is continuous: cut, delay and remainder meet end to start', () => {
  const { log } = replanChain({ eventAfterRealH: 5, delayH: 8, delayStatus: 'off-duty' })
  for (let i = 1; i < log.length; i += 1) {
    assert.ok(log[i].startedAt >= log[i - 1].endedAt - 1, `overlap at ${i}`)
  }
  const delayIdx = log.findIndex((e) => e.status === 'off-duty' && e.endedAt - e.startedAt === 8 * REAL_HOUR_MS)
  assert.ok(delayIdx > 0)
  assert.equal(log[delayIdx].startedAt, log[delayIdx - 1].endedAt, 'the delay starts where the cut ended the plan')
})

// Where a load stops on the way, and why.
//
// Trucks are not simulated continuously in this codebase (see
// tracking/position.js's own header): a load's position is computed from
// dispatched_at -> eta_at on every read, not stepped tick by tick. So a
// stop cannot be decided "as the truck reaches it" -- there is no such
// moment to hook into. It has to be decided ONCE, at dispatch, for the
// whole run, the same way eta_at itself is decided once at dispatch. This
// file is that one decision, and it is a pure function on purpose: no DB,
// no clock read beyond the timestamps it is handed, so it can be pinned
// down by test the same way truckWear.js's day-allocation math is.
//
// ---------------------------------------------------------------------
// The legal schedule decides the arrival, not the other way around
// ---------------------------------------------------------------------
//
// This used to run a "fuel pass" and a separate "rest pass" against
// DAILY_DRIVE_MI (a fixed-mileage cadence, and until the facilities.js
// fix, one computed off the WRONG legal number -- 14 hours, the duty
// window, instead of 11, the driving limit), then scaled every stop onto
// a window that was decided at dispatch and CUT any stop that wouldn't
// finish before it. That last part was the dangerous piece: etaAt came
// from the broker's promised transit time, so a broker window shorter
// than what HOS actually allows made this file throw away a driver's
// legally mandated rest and hand back a plan that quietly had the driver
// running 20 straight hours.
//
// This file now runs ONE forward simulation, in real hours of service,
// calling src/constants/hosClock.js's hosState() before every mile of
// driving it schedules -- the same authoritative check a caller would run
// to ask "may this driver drive right now". Nothing here reimplements
// the 11-hour driving limit, the 14-hour window, the 8-hour/30-minute
// break, or the 60/70-hour weekly limits: those numbers and that
// arithmetic live in hosClock.js, once, and this file only asks it
// questions. A promised broker window (promisedEtaAt) is compared
// AFTER the legal plan is built, never used to truncate it -- see
// legalArrivalAt and hosFacts below.
//
// Two kinds of stop this file places:
//   fuel -- the tank's own range, AVG_MPG against however many gallons it
//           is currently carrying, refuelling to full at whichever real
//           fuel-selling facility sits closest to (but not past) the
//           point the tank would run past its reserve.
//   rest -- 49 CFR 395.3: the 30-minute break after 8 hours of driving,
//           the 10-hour reset when the 11-hour driving limit or the
//           14-hour duty window runs out (whichever happens first), and
//           the 34-hour restart when the 60/7 or 70/8 weekly limit runs
//           out. All three are legally mandatory; none is ever dropped
//           because a facility wasn't nearby (see "roadside" below) or
//           because a promised window was too short to fit them.
//
// A facility candidate is projected onto the route's own geometry (real
// distance walked, exactly pointAlongPath's technique in position.js) --
// route_offset_mi is never "the Nth candidate", it is where that
// candidate ACTUALLY sits on the road.
//
// ---------------------------------------------------------------------
// Two clocks, on purpose
// ---------------------------------------------------------------------
//
// dutyTimeline is an ELD-shaped record: a driver's 11th hour of driving
// is really an 11th hour, so its startedAt/endedAt use LITERAL hours
// (1 hour = 3,600,000 ms), anchored at dispatchedAt. That is also
// exactly the domain hosState's own arithmetic assumes (it divides ms by
// 60000 to get minutes), which is what makes
// hosState(dutyTimeline, t).mayDrive a real, callable check on this
// file's own output, not just a description of one -- see
// test/stopPlan.test.js's own "machine proof" tests.
//
// legalArrivalAt and every stop's arrivedAt/departedAt, by contrast, are
// on the COMPRESSED calendar dispatched_at/eta_at already live on
// (src/constants/simClock.js -- one simulated day is thirty real minutes).
// The conversion is the same one this codebase already uses for a
// mandatory rest's duration (REQUIRED_REST_SIM_DAYS -> simDaysToMs,
// hos.js/dispatch.service.js): a quantity of real HOS hours, divided by
// 24 and run through simClock.js's own simDaysToMs -- never a hand-typed
// ms-per-hour figure of this file's own invention.

import { AVG_MPG } from '../finance/finance.constants.js'
import {
  BREAK_AFTER_DRIVING_HOURS, BREAK_MINUTES,
  REQUIRED_REST_HOURS, RESTART_HOURS, DUTY_STATUS, hosState,
  toHosDomain, withOffDutyGaps, HOS_TIME_SCALE,
} from '../../constants/hosClock.js'
import { simDaysToMs } from '../../constants/simClock.js'
import { clockDateTime } from '../../constants/appClock.js'
import { SPACING_MI, MERGE_RADIUS_MI, AVG_HIGHWAY_MPH } from '../../../scripts/seed/facilities.js'
import { haversineMi } from '../../../scripts/seed/cities.js'

const FUEL_SELLING_KINDS = new Set(['fuel', 'truck_stop'])

// How much tank range is kept in reserve, so the tank never has to close
// a gap wider than the worst case the facility network itself was BUILT
// to guarantee. Every generated corridor places a facility at most
// SPACING_MI apart (scripts/seed/facilities.js's own header) -- so a
// truck that still has SPACING_MI of range left, at the moment it passes
// a facility, is guaranteed to reach the NEXT one too. Reusing SPACING_MI
// here is not a second guess at a safety margin; it is the same number
// the corridor's own density was sized against.
export const FUEL_RESERVE_MI = SPACING_MI

// How far a facility may sit from the route's own line and still count
// as "on this route" rather than "somewhere else the same corridor
// happens to pass near". Reuses MERGE_RADIUS_MI (scripts/seed/
// facilities.js) -- the SAME distance the generator itself uses to decide
// two points are the same real-world stop, not a second radius invented
// for this file.
export const ROUTE_CORRIDOR_MI = MERGE_RADIUS_MI

// A fuel-only stop (no break/rest riding along with it) is short --
// long enough to actually be a stop, nowhere near a mandatory rest. This
// project tracks no metered truck-stop pump-rate figure (no live feed,
// no fetched source for one), so -- the same admission facilities.js's
// own FACILITY_KIND_MIX already makes for its kind mix -- this is a
// STATED modeling decision, not a measured one: gallons pumped at a
// fixed rate, in REAL ELD minutes (this is on-duty-not-driving time on
// the SAME literal-hours clock dutyTimeline itself runs on -- see the
// file header on the two clocks). At a 250-gal fill (a big rig's full
// tank) that is 25 literal ELD minutes (not scaled by the day length; about 31 real seconds at HOS_TIME_SCALE 48), comfortably short of the 30-minute
// break threshold on its own -- which is the property that actually
// matters: an ordinary fuel stop does not, by itself, look like a
// driver's mandatory break. When one legitimately falls due at the same
// point (8 hours of driving since the last one), this file extends the
// SAME fuel stop to cover it instead of adding a second, separate one --
// hosClock.js's own header: "any 30 consecutive minutes NOT driving"
// satisfies the break, on-duty-not-driving included.
export const FUEL_STOP_MIN_PER_GAL = 0.1

// A safety cap on how many stops one route can ask for, independent of
// how many facilities exist or how long the route is. Exists only so a
// pathological input (near-zero startFuelGallons, a route long enough to
// need hundreds of resets) cannot spin forever -- every real call
// terminates long before this because posMi strictly increases (or the
// loop breaks on "run out of miles") each iteration.
const MAX_STOPS = 400

// gallons * price, rounded once -- the SAME shape truckWear.js's
// fuelCostForGallons uses, just against a FACILITY's own price
// (fuel_price_cents/100) instead of the fleet-wide FUEL_PRICE_PER_GAL.
// Not calling fuelCostForGallons itself: that function is pinned to the
// global constant by truckWear.test.js's own equivalence test, and a
// facility legitimately charges a different price than the fleet
// average (035's whole reason for having fuel_price_cents per row).
function costForGallonsAt(gallons, priceCentsPerGal) {
  return Math.round(gallons * (priceCentsPerGal / 100))
}

// Literal real time -- the ELD's own clock, and hosState's. Never
// confused with the compressed calendar (hoursToCompressedMs below):
// this file's own header explains why the two must stay separate.
// Rounded to whole milliseconds: dutyTimeline is serialized as ISO
// strings (ms precision) and checked again by hosState from THAT form
// (test/stopPlan.test.js's machine proof). An unrounded float here meant
// the loop decided on one timeline and returned a slightly different one
// -- close enough to the 8-hour line that the two disagreed on it.
function hoursToMs(hours) {
  return Math.round(hours * 60 * 60 * 1000)
}

// The SAME quantity of real HOS hours, converted onto the compressed
// game calendar via simClock.js's own simDaysToMs -- the identical
// pattern this codebase already uses for REQUIRED_REST_SIM_DAYS
// (hos.js/dispatch.service.js): hours -> days (/24) -> simDaysToMs. No
// ms-per-hour figure is typed by hand here.
function hoursToCompressedMs(hours) {
  return simDaysToMs(hours / 24)
}

// The point on segment [a,b] closest to `p`, and how far along the
// segment (t in [0,1]) it sits. Plain lat/lon lerp for the projection --
// the same choice pointAlongPath makes for interpolation WITHIN a
// segment (position.js's own comment: a route's segments are short by
// construction, so the lerp error over a few miles is negligible).
function closestPointOnSegment(p, a, b) {
  const dx = b.lon - a.lon
  const dy = b.lat - a.lat
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { t: 0, lat: a.lat, lon: a.lon }
  let t = ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return { t, lat: a.lat + t * dy, lon: a.lon + t * dx }
}

// Projects `point` onto `geometry` ([[lon,lat], ...], OSRM order -- same
// shape pointAlongPath takes) and returns how far along the path (by
// REAL distance, walking every segment and summing haversineMi -- never
// by which vertex is nearest) the closest approach sits, and how far off
// the path `point` itself is. Exported for direct testing: this is the
// function the "route_offset_mi is computed by distance, not index" rule
// actually lives in.
export function projectOntoRoute(geometry, point) {
  let offsetMi = 0
  let perpMi = Infinity
  let coveredMi = 0

  for (let i = 0; i < geometry.length - 1; i += 1) {
    const [lon1, lat1] = geometry[i]
    const [lon2, lat2] = geometry[i + 1]
    const a = { lat: lat1, lon: lon1 }
    const b = { lat: lat2, lon: lon2 }
    const segMi = haversineMi(a, b)

    if (segMi > 0) {
      const { t, lat, lon } = closestPointOnSegment(point, a, b)
      const distMi = haversineMi(point, { lat, lon })
      if (distMi < perpMi) {
        perpMi = distMi
        offsetMi = coveredMi + t * segMi
      }
    }
    coveredMi += segMi
  }

  // totalMi is coveredMi after the loop -- returned so callers can scale
  // this raw, real-geometry offset into whatever distance basis they
  // need (see planStops' own header on why route_offset_mi is stored in
  // load.distanceMi's units, not the route geometry's own length).
  return { offsetMi, perpMi, totalMi: coveredMi }
}

// The geometry's own real length -- sum of every segment's haversineMi,
// the same walk projectOntoRoute does, without a point to project.
function pathLengthMi(geometry) {
  let totalMi = 0
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const [lon1, lat1] = geometry[i]
    const [lon2, lat2] = geometry[i + 1]
    totalMi += haversineMi({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 })
  }
  return totalMi
}

// The nearest candidate (by scaled route offset) strictly after `fromMi`
// and at or before `toMi` -- greedy toward the CAP, same choice the old
// two-pass version made: drive as far as the law/tank allows before
// stopping, not to the first facility that happens to qualify.
function nearestWithin(pool, fromMi, toMi, scaleToDistanceMi) {
  return pool
    .filter((f) => {
      const mi = f.rawOffsetMi * scaleToDistanceMi
      return mi > fromMi && mi <= toMi
    })
    .sort((a, b) => b.rawOffsetMi - a.rawOffsetMi)[0] ?? null
}

// facilities: raw candidates ({id, kind, lat, lon, fuelPriceCents, ...}),
// typically every known facility (facilities.service.js's listAll()) --
// this function does the corridor filtering itself (perpMi <=
// ROUTE_CORRIDOR_MI), so a caller does not need to pre-filter by
// geography, only by nothing at all.
//
// promisedEtaAt is informational, never a cutoff (see file header) --
// pass it to get a LATE_VS_PROMISED fact when the legal plan runs past
// it; omit it and planStops simply has nothing to compare against.
//
// Returns { stops, dutyTimeline, legalArrivalAt, hosFacts, warnings }.
// stops never drops a legally-required rest/break for lack of a nearby
// facility or a short promise -- see the "sig'masa jim qolmasin"
// requirement in hosFacts's own comments below. A stop this function
// could not fully plan (no cached route, no facility at all for a
// mandatory rest) says so through hosFacts/warnings, never by silently
// returning fewer rows than the law required.
// How much more Off Duty the driver owes before hosState will let them
// drive, given the limits it just reported. A break needs 30 minutes; a
// daily limit needs the 10-hour rest; a weekly limit needs the 34-hour
// restart -- MINUS whatever unbroken rest the driver is already sitting
// in at nowHosMs (a driver six hours into a between-loads rest owes four
// more, not ten). Never less than one minute, so the loop always moves.
function offDutyStillOwedHours(events, nowHosMs, limits) {
  const codes = new Set(limits.map((l) => l.code))
  const requiredHrs = (codes.has('WEEKLY_60_7') || codes.has('WEEKLY_70_8'))
    ? RESTART_HOURS
    : (codes.has('DRIVING_LIMIT') || codes.has('DUTY_WINDOW'))
      ? REQUIRED_REST_HOURS
      : BREAK_MINUTES / 60
  let restStart = nowHosMs
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    const isRest = e.status === DUTY_STATUS.OFF_DUTY || e.status === DUTY_STATUS.SLEEPER_BERTH
    if (!isRest || e.endedAt < restStart) break
    restStart = Math.min(restStart, e.startedAt)
  }
  const alreadyHrs = (nowHosMs - restStart) / hoursToMs(1)
  return Math.max(1 / 60, requiredHrs - alreadyHrs)
}

// Which clock is (all but) out, and the Off Duty it needs: the tightest
// of hosState's own remaining-minute fields decides, never a re-derivation.
function earlyStopFor(state) {
  const clocks = [
    { min: state.dutyMinutesInWindow7DayRemaining, hours: RESTART_HOURS, code: 'WEEKLY_60_7', cfr: '395.3(b)(1)' },
    { min: state.dutyMinutesInWindow8DayRemaining, hours: RESTART_HOURS, code: 'WEEKLY_70_8', cfr: '395.3(b)(2)' },
    { min: state.drivingMinutesRemaining, hours: REQUIRED_REST_HOURS, code: 'DRIVING_LIMIT', cfr: '395.3(a)(3)' },
    { min: state.windowMinutesRemaining, hours: REQUIRED_REST_HOURS, code: 'DUTY_WINDOW', cfr: '395.3(a)(2)' },
    { min: state.minutesUntilBreakRequired, hours: BREAK_MINUTES / 60, code: 'BREAK_REQUIRED', cfr: '395.3(a)(3)(ii)' },
  ]
  // Ties go to the longer rest (listed first): a 10-hour rest also
  // satisfies the 30-minute break, the reverse is not true.
  const tightest = clocks.reduce((a, b) => (b.min < a.min ? b : a))
  return {
    ...tightest,
    detail: `Under a minute left on the ${tightest.code} clock -- ${formatHours(tightest.hours)} off duty before driving on.`,
  }
}

function formatHours(hours) {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function planStops({
  routeGeometry, distanceMi, startFuelGallons, fuelCapacityGal,
  facilities, dispatchedAt, promisedEtaAt, priorDutyEvents = [],
}) {
  const warnings = []
  const hosFacts = []
  const empty = (code) => ({
    stops: [], dutyTimeline: [], legalArrivalAt: null, hosFacts, warnings: [{ code }],
  })

  if (!Array.isArray(routeGeometry) || routeGeometry.length < 2) return empty('no-route')
  if (!(distanceMi > 0)) return empty('bad-distance')

  const dispatchedMs = new Date(dispatchedAt).getTime()
  if (!Number.isFinite(dispatchedMs)) return empty('bad-dispatch-time')
  if (!(fuelCapacityGal > 0)) return empty('bad-truck')

  const havePromise = promisedEtaAt != null
  let promisedMs = havePromise ? new Date(promisedEtaAt).getTime() : null
  if (havePromise && !Number.isFinite(promisedMs)) {
    warnings.push({ code: 'bad-promised-eta' })
    promisedMs = null
  }

  // Project every candidate once. rawOffsetMi/totalGeometryMi are in the
  // route geometry's own real miles; scaled to distanceMi's own units
  // below via scaleToDistanceMi, the same "real distance, not vertex
  // index" discipline projectOntoRoute itself follows.
  const projected = (facilities || [])
    .map((f) => {
      const lat = Number(f.lat)
      const lon = Number(f.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
      const { offsetMi, perpMi } = projectOntoRoute(routeGeometry, { lat, lon })
      return { ...f, rawOffsetMi: offsetMi, perpMi }
    })
    .filter((f) => f && f.perpMi <= ROUTE_CORRIDOR_MI)

  const totalGeometryMi = pathLengthMi(routeGeometry)
  // A degenerate (zero-length) geometry can't host a scaled offset --
  // treated as "no route" rather than dividing by zero.
  if (!(totalGeometryMi > 0)) return empty('no-route')
  const scaleToDistanceMi = distanceMi / totalGeometryMi

  const fuelFacilities = projected.filter((f) => FUEL_SELLING_KINDS.has(f.kind))

  // -------------------------------------------------------------------
  // The forward simulation.
  // -------------------------------------------------------------------
  // posMi: how far along the run we are (distanceMi's own units).
  // hoursElapsed: real HOS hours since dispatch -- the ELD clock. Every
  //   ms value pushed onto `events` is dispatchedMs + hoursToMs(this),
  //   which is exactly the literal domain hosState expects.
  // events: the dutyTimeline being built, in that literal domain --
  //   this is the SAME array handed to hosState on every iteration, so
  //   the loop's own stop/go decisions and the eventual machine-proof
  //   test (hosState(dutyTimeline, t).mayDrive at every driving start)
  //   run against identical data.
  let posMi = 0
  let hoursElapsed = 0
  let tankGallons = startFuelGallons
  // Set once a required fuel stop finds no facility in range -- the same
  // "warn and stop looking" the old two-pass version did (it broke out
  // of its own fuel while-loop the first time this happened). Legal
  // stops keep being planned normally; only fuel bookkeeping stops.
  let fuelSearchAbandoned = false
  // The driver's own recent log (duty_events, on the compressed calendar)
  // in literal hours around dispatchedMs, with every unrecorded gap up to
  // the dispatch moment filled as Off Duty (hosClock.js's withOffDutyGaps
  // explains why a gap is rest). This is what makes a driver who delivered
  // a 600-mile run twenty real seconds ago start THIS run on a 10-hour
  // rest instead of a fresh 11 hours -- and what makes the 60/70-hour
  // weekly limits accumulate across loads at all. Prior events are seeded
  // into `events` so hosState sees them, and sliced off again before
  // dutyTimeline is returned: this function plans THIS run only.
  const events = withOffDutyGaps(toHosDomain(priorDutyEvents, dispatchedMs), dispatchedMs)
    .filter((e) => e.startedAt < dispatchedMs)
    .map((e) => ({ status: e.status, startedAt: e.startedAt, endedAt: Math.min(e.endedAt, dispatchedMs) }))
  const priorCount = events.length
  const stops = []

  const pushDriving = (fromHrs, toHrs) => {
    if (toHrs <= fromHrs) return
    events.push({ status: DUTY_STATUS.DRIVING, startedAt: dispatchedMs + hoursToMs(fromHrs), endedAt: dispatchedMs + hoursToMs(toHrs) })
  }
  const pushStationary = (status, fromHrs, toHrs, where = {}) => {
    events.push({
      status,
      startedAt: dispatchedMs + hoursToMs(fromHrs),
      endedAt: dispatchedMs + hoursToMs(toHrs),
      routeOffsetMi: where.offsetMi == null ? null : Math.round(where.offsetMi),
      facilityId: where.facilityId ?? null,
    })
  }
  const stopRecord = (facility, offsetMi, reason, fromHrs, toHrs, gallons, costUsd) => ({
    facilityId: facility.id,
    reason,
    routeOffsetMi: Math.round(offsetMi),
    arrivedAt: new Date(dispatchedMs + hoursToCompressedMs(fromHrs)).toISOString(),
    departedAt: new Date(dispatchedMs + hoursToCompressedMs(toHrs)).toISOString(),
    gallons,
    costUsd,
  })

  let guard = 0
  while (posMi < distanceMi - 1e-9 && guard < MAX_STOPS) {
    guard += 1

    // The authoritative check, run BEFORE every mile of driving this
    // loop schedules. Invariant maintained below: every branch that
    // stops the truck fully resolves whatever hosState just flagged
    // before the loop comes back here, so this should always read
    // mayDrive: true. It is checked anyway -- silently driving through
    // a limit this function itself failed to clear would be exactly
    // the "jimgina notoʻgʻri" outcome the whole rewrite exists to stop.
    const state = hosState(events, dispatchedMs + hoursToMs(hoursElapsed))
    if (!state.mayDrive) {
      const nowHosMs = dispatchedMs + hoursToMs(hoursElapsed)
      const offHrs = offDutyStillOwedHours(events, nowHosMs, state.limits)
      if (posMi === 0 && hoursElapsed === 0) {
        // Not a planning bug: the driver arrives at this dispatch already
        // out of hours from their own earlier runs (priorDutyEvents).
        // The rest they still owe is the first thing on this run's log,
        // at the origin, and it is said as a fact with its CFR reference.
        for (const lim of state.limits) {
          hosFacts.push({
            code: lim.code,
            cfr: lim.cfr,
            detail: `${lim.detail} Carried over from earlier runs -- ${formatHours(offHrs)} off duty at the origin before driving.`,
          })
        }
      } else {
        warnings.push({ code: 'unexpected-hos-block', atMi: Math.round(posMi) })
      }
      pushStationary(DUTY_STATUS.OFF_DUTY, hoursElapsed, hoursElapsed + offHrs, { offsetMi: posMi })
      hoursElapsed += offHrs
      continue
    }

    // How far the DRIVER may legally drive before the tightest of the
    // three HOS clocks runs out -- all three numbers come straight out
    // of hosState, never recomputed here.
    // The weekly limits are clocks too: without them a driver 20 minutes
    // short of 70 hours was handed a full 11-hour leg.
    const hosCapHours = Math.min(
      state.drivingMinutesRemaining, state.windowMinutesRemaining, state.minutesUntilBreakRequired,
      state.dutyMinutesInWindow7DayRemaining, state.dutyMinutesInWindow8DayRemaining,
    ) / 60
    const hosCapMi = hosCapHours * AVG_HIGHWAY_MPH
    // How far the TANK may go before dipping under its reserve.
    const fuelCapMi = fuelSearchAbandoned ? Infinity : Math.max(0, tankGallons * AVG_MPG - FUEL_RESERVE_MI)
    const remainingMi = distanceMi - posMi
    const rawCapMi = Math.min(hosCapMi, fuelCapMi, remainingMi)
    // hosCapMi is built from hosState's own ROUNDED minute fields (its
    // comment: those are display/decision rounding, never the `limits`
    // check itself, which stays exact). That rounding can floor a real
    // but sub-minute margin to a cap of 0 miles while state.mayDrive is
    // still (correctly) true -- with no minimum, this loop would then
    // drive 0mi forever, never crossing the real threshold hosState
    // itself is measuring exactly. MIN_STEP_MI (one rounded minute's
    // worth of driving) guarantees forward progress on every non-finishing
    // iteration; it is never applied when the cap is what lets the run
    // FINISH (rawCapMi >= remainingMi), so a short final leg is never
    // padded past its own true distance.
    const MIN_STEP_MI = AVG_HIGHWAY_MPH / 60
    // Less than a rounded minute left on an HOS clock (not the tank's) is
    // that clock having run out, for planning purposes: stopping a minute
    // EARLY is always legal, driving a minute past it never is. The old
    // MIN_STEP_MI padding applied here too, and drove the truck up to a
    // minute past the 8-hour line -- which the machine-proof test only
    // caught once hosClock.js stopped dropping ISO-string events as NaN.
    // So: take the break/rest this clock needs right here, then loop.
    if (hosCapMi < MIN_STEP_MI && hosCapMi < remainingMi - 1e-9) {
      const owed = earlyStopFor(state)
      pushStationary(DUTY_STATUS.OFF_DUTY, hoursElapsed, hoursElapsed + owed.hours, { offsetMi: posMi })
      hosFacts.push({ code: owed.code, cfr: owed.cfr, detail: `${owed.detail} Stopped at mile ${Math.round(posMi)}.` })
      hoursElapsed += owed.hours
      continue
    }
    const capMi = rawCapMi < remainingMi - 1e-9 ? Math.max(rawCapMi, MIN_STEP_MI) : rawCapMi

    if (capMi >= remainingMi - 1e-9) {
      // The rest of the run fits inside every clock at once -- drive it
      // and finish. No stop follows; distance is what runs out, not any
      // limit.
      pushDriving(hoursElapsed, hoursElapsed + remainingMi / AVG_HIGHWAY_MPH)
      hoursElapsed += remainingMi / AVG_HIGHWAY_MPH
      posMi = distanceMi
      break
    }

    // A stop is required. fuelBinding says whether the TANK is the
    // tightest constraint reaching this cap -- if so, the facility
    // search below is restricted to fuel-selling kinds; the drive still
    // stops exactly here either way.
    const fuelBinding = fuelCapMi <= hosCapMi + 1e-9
    const pool = fuelBinding ? fuelFacilities : projected
    const candidate = nearestWithin(pool, posMi, posMi + capMi, scaleToDistanceMi)
    const driveMi = candidate ? (candidate.rawOffsetMi * scaleToDistanceMi - posMi) : capMi
    const driveHrs = driveMi / AVG_HIGHWAY_MPH

    pushDriving(hoursElapsed, hoursElapsed + driveHrs)
    hoursElapsed += driveHrs
    posMi += driveMi
    tankGallons = Math.max(0, tankGallons - driveMi / AVG_MPG)

    const facilityHere = candidate
    const offsetHere = candidate ? candidate.rawOffsetMi * scaleToDistanceMi : posMi

    // What's actually required, right here, right now -- straight off
    // hosState's own `limits`, not re-derived.
    const afterDrive = hosState(events, dispatchedMs + hoursToMs(hoursElapsed))
    const codes = new Set(afterDrive.limits.map((l) => l.code))
    const weeklyNeeded = codes.has('WEEKLY_60_7') || codes.has('WEEKLY_70_8')
    const dailyResetNeeded = !weeklyNeeded && (codes.has('DRIVING_LIMIT') || codes.has('DUTY_WINDOW'))
    const breakNeeded = !weeklyNeeded && !dailyResetNeeded && codes.has('BREAK_REQUIRED')

    let neededFuel = false
    if (fuelBinding) {
      if (facilityHere) {
        neededFuel = true
      } else {
        warnings.push({ code: 'fuel-stop-unavailable', afterMi: Math.round(posMi) })
        hosFacts.push({
          code: 'FUEL_STOP_UNAVAILABLE',
          cfr: null,
          detail: `No fuel-selling facility found within ${Math.round(capMi)}mi of mile ${Math.round(posMi)}; `
            + 'fuel planning is abandoned for the rest of this run rather than guessing a location for it.',
        })
        fuelSearchAbandoned = true
      }
    }

    // Fuel first, when it's needed here -- and if a break is ALSO due at
    // this exact point, the fuel stop itself is stretched to cover it
    // (hosClock.js: "any 30 consecutive minutes NOT driving" satisfies
    // the break) instead of a second stop being added right after it.
    if (neededFuel) {
      const gallonsPurchased = Math.max(1, Math.round(fuelCapacityGal - tankGallons))
      const costUsd = costForGallonsAt(gallonsPurchased, facilityHere.fuelPriceCents)
      let fuelHrs = Math.max(1, gallonsPurchased * FUEL_STOP_MIN_PER_GAL) / 60
      if (breakNeeded) fuelHrs = Math.max(fuelHrs, BREAK_MINUTES / 60)

      pushStationary(DUTY_STATUS.ON_DUTY_NOT_DRIVING, hoursElapsed, hoursElapsed + fuelHrs, { offsetMi: offsetHere, facilityId: facilityHere.id })
      stops.push(stopRecord(facilityHere, offsetHere, 'fuel', hoursElapsed, hoursElapsed + fuelHrs, gallonsPurchased, costUsd))
      hosFacts.push({
        code: 'FUEL_STOP',
        cfr: null,
        detail: breakNeeded
          ? `Refueled ${gallonsPurchased} gal at ${facilityHere.id} (mile ${Math.round(offsetHere)}) -- `
            + `this stop also covers the 30-minute break required after ${BREAK_AFTER_DRIVING_HOURS} hours of driving (49 CFR 395.3(a)(3)(ii)).`
          : `Refueled ${gallonsPurchased} gal at ${facilityHere.id} (mile ${Math.round(offsetHere)}).`,
      })
      hoursElapsed += fuelHrs
      tankGallons = fuelCapacityGal
    }

    // A 30-minute break already absorbed into a fuel stop above is not
    // added again; a full reset or restart is NEVER absorbed into a
    // short fuel stop and always gets its own, longer stationary block,
    // right after fuel if both were due at the same point.
    if (weeklyNeeded || dailyResetNeeded || (breakNeeded && !neededFuel)) {
      const offHrs = weeklyNeeded ? RESTART_HOURS : dailyResetNeeded ? REQUIRED_REST_HOURS : BREAK_MINUTES / 60
      pushStationary(DUTY_STATUS.OFF_DUTY, hoursElapsed, hoursElapsed + offHrs, { offsetMi: offsetHere, facilityId: facilityHere?.id })

      const where = facilityHere
        ? `at ${facilityHere.id} (mile ${Math.round(offsetHere)})`
        : `on the shoulder at mile ${Math.round(offsetHere)} -- no facility inside the routing corridor`
      for (const lim of afterDrive.limits) {
        hosFacts.push({ code: lim.code, cfr: lim.cfr, detail: `${lim.detail} Stopped ${where}.` })
      }

      if (facilityHere) {
        stops.push(stopRecord(facilityHere, offsetHere, 'rest', hoursElapsed, hoursElapsed + offHrs, null, null))
      } else {
        // The rest is real and is IN dutyTimeline/legalArrivalAt above --
        // it just has no facilities row, because stop_visits.facility_id
        // is NOT NULL (036) and there is no real-world facility here to
        // reference. A warning either way: this is never a silent gap.
        warnings.push({ code: 'no-facility-for-rest', atOffsetMi: Math.round(offsetHere) })
      }
      hoursElapsed += offHrs
    }
  }
  if (guard >= MAX_STOPS) {
    warnings.push({ code: 'stop-limit-reached', stopCount: stops.length })
  }

  const legalArrivalAt = new Date(dispatchedMs + hoursToCompressedMs(hoursElapsed)).toISOString()
  const legalArrivalMs = new Date(legalArrivalAt).getTime()

  if (promisedMs != null && legalArrivalMs > promisedMs) {
    hosFacts.push({
      code: 'LATE_VS_PROMISED',
      cfr: null,
      // On the company clock, as a person reads a time -- not an ISO string
      // in UTC, which is what the Trip plan printed until 2026-10-08.
      detail: `The HOS-legal arrival (${clockDateTime(legalArrivalAt)} CT) is after the broker's promised window `
        + `(${clockDateTime(new Date(promisedMs).toISOString())} CT) -- the mandatory rest and break time above does not fit inside it.`,
    })
  }

  // Literal hours around dispatchedMs (see the two-clocks header) --
  // hosClock.js's fromHosDomain(dutyTimeline, dispatchedMs) puts it back
  // on the compressed calendar for duty_events. Prior history is not part
  // of THIS run's timeline.
  const dutyTimeline = events.slice(priorCount).map((e) => ({
    status: e.status,
    startedAt: new Date(e.startedAt).toISOString(),
    endedAt: new Date(e.endedAt).toISOString(),
    routeOffsetMi: e.routeOffsetMi ?? null,
    facilityId: e.facilityId ?? null,
  }))

  return { stops, dutyTimeline, legalArrivalAt, hosFacts, warnings }
}

// This file's own warning codes, as sentences a dispatcher can read --
// dispatch.service.js stores them on the load (037's stop_plan_facts).
// Kept next to the codes so a new one cannot be added without a sentence
// (test/stopPlan.test.js reads every code out of this file and checks).
export function describeWarning(w) {
  switch (w.code) {
    case 'no-facility-for-rest':
      return `A required rest at mile ${w.atOffsetMi} has no facility inside the routing corridor; it is planned on the shoulder.`
    case 'fuel-stop-unavailable':
      return `No fuel-selling facility was in range after mile ${w.afterMi}; fuel was not planned past that point.`
    case 'stop-limit-reached':
      return `The planner stopped after ${w.stopCount} stops (safety cap); the rest of the run has no planned stops.`
    case 'unexpected-hos-block':
      return `The planner found the driver out of hours at mile ${w.atMi} without having scheduled that rest itself; an extra rest was added there.`
    case 'bad-promised-eta':
      return 'The broker\'s promised ETA could not be read, so it was not compared against the legal arrival.'
    case 'no-route':
      return 'The cached route geometry is missing or degenerate, so no stops could be placed along it.'
    case 'bad-distance':
      return 'The load has no usable distance, so no stops could be planned.'
    case 'bad-dispatch-time':
      return 'The load has no readable dispatch time, so no duty timeline could be built.'
    case 'bad-truck':
      return 'The truck has no usable fuel capacity, so fuel stops could not be planned.'
    default:
      return `Planner warning: ${w.code}.`
  }
}

// ---------------------------------------------------------------------
// Re-planning after a road event (loadEvents resolve)
// ---------------------------------------------------------------------

// How far the run had got by atMs, by this file's own arithmetic: every
// DRIVING event of the run (compressed calendar), up to atMs, converted
// to HOS hours and multiplied by the same AVG_HIGHWAY_MPH the plan was
// built with -- so the replan starts exactly where the plan says the
// truck was, never at a second, differently-derived position.
export function drivenMilesBefore(events, atMs) {
  const at = new Date(atMs).getTime()
  let hosMs = 0
  for (const e of events || []) {
    if (e.status !== DUTY_STATUS.DRIVING) continue
    const s = new Date(e.startedAt).getTime()
    const en = Math.min(new Date(e.endedAt).getTime(), at)
    if (en > s) hosMs += (en - s) * HOS_TIME_SCALE
  }
  return (hosMs / hoursToMs(1)) * AVG_HIGHWAY_MPH
}

// The part of a route geometry from `fraction` of its real length to the
// end, starting with the exact interpolated point. [] for a degenerate
// geometry; the full geometry for fraction <= 0.
export function sliceRouteFrom(geometry, fraction) {
  if (!Array.isArray(geometry) || geometry.length < 2) return []
  if (!(fraction > 0)) return geometry.slice()
  const total = pathLengthMi(geometry)
  if (!(total > 0)) return []
  const target = Math.min(1, fraction) * total
  let covered = 0
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const [lon1, lat1] = geometry[i]
    const [lon2, lat2] = geometry[i + 1]
    const len = haversineMi({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 })
    if (covered + len >= target) {
      const t = len > 0 ? (target - covered) / len : 0
      const start = [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]
      return [start, ...geometry.slice(i + 1)]
    }
    covered += len
  }
  return [geometry[geometry.length - 1], geometry[geometry.length - 1]]
}

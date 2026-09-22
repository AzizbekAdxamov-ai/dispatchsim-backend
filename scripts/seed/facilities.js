// Where a fuel stop, truck stop, rest area or repair shop sits along a
// road, and what it's called and charges once it's there.
//
// Nothing here touches the database or the network -- placeAlongRoute
// takes one lane_routes (034) geometry and the facilities already known
// to exist, and returns new stop points by pure distance math, the same
// "no I/O in the math" discipline as scripts/seed/cities.js and
// generate.js. scripts/generate-facilities.js is the only thing that
// turns what this file computes into rows.

import { CITIES, haversineMi } from './cities.js'
import { DRIVING_LIMIT_HOURS } from '../../src/constants/hosClock.js'
import { FUEL_PRICE_PER_GAL } from '../../src/modules/finance/finance.constants.js'

// Deliberately imports NOTHING from vocabulary.js/vocabularySchema.js/
// validate.js, even though vocabularySchema.js imports MAX_STOPS_PER_ROUTE
// FROM this file below. Importing back would recreate the exact
// vocabulary -> vocabularySchema -> generate -> vocabulary cycle
// vocabulary.js's own header describes -- this file stays a leaf, the
// same role marketTargets.js already plays for the load/applicant/truck
// generators.

// ---------------------------------------------------------------------
// Spacing -- how far apart facilities should sit, computed, not chosen
// ---------------------------------------------------------------------
//
// The requirement is a real one: a driver has to see SEVERAL options in
// one driving day, or "where do I stop" is not a decision -- it's
// whatever the map happened to place nearest. So the unit to divide is a
// driving day, not a mileage picked because it sounded reasonable.
//
// THIS BLOCK USED TO GET THE LEGAL NUMBER WRONG. It computed
// DRIVING_HOURS_PER_DAY as `24 - REQUIRED_REST_HOURS` (= 14) and called
// that a driver's daily drive time -- DAILY_DRIVE_MI came out to
// 14h * 55mph = 770 miles. Fourteen hours is real, but it is the DUTY
// WINDOW (49 CFR 395.3(a)(2)): the clock inside which a driver may be
// on duty at all, driving or not. It is not how long a driver may
// DRIVE. That number is 11 hours (395.3(a)(3)), and the gap between the
// two is exactly the confusion src/constants/hosClock.js's own header
// was written to stop -- this file was the bug that header describes.
// Meanwhile src/modules/loads/loads.repository.js was already setting
// hos_remaining_min = 660 (11 hours) on release, correctly. Same
// codebase, two different legal numbers for the same question, until
// now.
//
//   1. How many hours can a driver actually DRIVE in a day?
//      DRIVING_LIMIT_HOURS (src/constants/hosClock.js), 49 CFR
//      395.3(a)(3) -- 11 hours, following 10 consecutive hours off duty.
//      Imported, not retyped, so this file and hosClock.js's own
//      stopPlan.js-facing simulation can never drift apart on it again.
//
//   2. How far does 11 hours of driving cover? src/modules/loadBoard/
//      loadBoard.service.js already estimates drive time at 55 mph
//      ("Drive time ~ deadheadMi / 55 mph") -- reused here rather than a
//      second guess at highway speed, so the two places this project
//      estimates a truck's speed can't quietly disagree.
//
//        DAILY_DRIVE_MI = 11h * 55mph = 605 miles
//
//   3. "Several options" across that day, not one: split the driving day
//      into quarters, so a decision point is never more than a quarter of
//      the day's drive (~2.75h) away. Four is the smallest split that
//      still reads as "several" rather than "twice" -- two would still
//      leave up to five and a half hours between chances to stop.
//
//        SPACING_MI = round(605 / 4) = 151 miles
//
// Shrinking DAILY_DRIVE_MI from 770 to 605 shrinks SPACING_MI (193 -> 151)
// and MERGE_RADIUS_MI (24 -> 19) with it -- a DENSER corridor, never a
// sparser one. That is safe on both sides this file has to answer for:
//   - Existing facility rows are not deleted and do not need to be: a
//     denser target spacing only adds NEW candidate points between the
//     ones already placed at the old, wider spacing (placeAlongRoute's
//     own existing-point merge check drops a new candidate that lands
//     near one of them) -- it never invalidates an old point, and
//     stop_visits.facility_id is a RESTRICT foreign key (034) that
//     would block deleting one anyway. Re-running facilities:generate
//     after this change adds points; it does not need to, and cannot,
//     remove any.
//   - FUEL_RESERVE_MI (stopPlan.js) is defined as SPACING_MI, so it
//     shrinks by the same fraction. That is still the correct number:
//     FUEL_RESERVE_MI's whole job is "how much range must be left when a
//     truck passes a facility, to guarantee it reaches the NEXT one" --
//     and the next one is now, at most, 151mi away instead of 193mi. A
//     smaller guaranteed gap needs a smaller reserve, not a bigger one.
export const AVG_HIGHWAY_MPH = 55
export const DAILY_DRIVE_MI = DRIVING_LIMIT_HOURS * AVG_HIGHWAY_MPH
const STOPS_PER_DRIVING_DAY = 4
export const SPACING_MI = Math.round(DAILY_DRIVE_MI / STOPS_PER_DRIVING_DAY)

// Merge radius -- how close two candidate points have to be before they
// count as the same real-world stop, so two lanes sharing a highway
// corridor share the corridor's facilities instead of each planting its
// own next to the other's.
//
// Computed as a fraction of SPACING_MI rather than picked outright, for
// one reason: it has to sit clearly BELOW half of SPACING_MI, or two
// stops the generator deliberately placed a full interval apart could
// merge into one and silently thin out the corridor SPACING_MI was
// computed to keep dense. 1/8 of SPACING_MI (~24mi) leaves a wide margin
// below that half-spacing line (~96mi) while still being roomy enough to
// catch the same real interchange approached from two different
// directions through the same metro area -- two routes entering the same
// city from opposite sides can interpolate to points several miles apart
// without being two different truck stops.
const MERGE_RADIUS_DIVISOR = 8
export const MERGE_RADIUS_MI = Math.round(SPACING_MI / MERGE_RADIUS_DIVISOR)

// The longest a cached route can be (lane_routes_distance_range, 034's
// own CHECK: `distance_mi > 0 AND distance_mi <= 4000`). Reused here,
// not retyped, to size the name lists below off the SAME ceiling the
// database already enforces.
export const MAX_LANE_ROUTE_MI = 4000

// The worst case a single route can ever produce for one name list: every
// stop on the longest possible cached route landing on the same kind.
// vocabularySchema.js sizes TRUCK_STOP_NAMES/REPAIR_SHOP_NAMES off this
// exact number, the same "board math, not taste" reasoning as
// vocabularySchema.js's own COMMODITY_MIN.
export const MAX_STOPS_PER_ROUTE = Math.ceil(MAX_LANE_ROUTE_MI / SPACING_MI)

function round4(n) {
  return Math.round(n * 10000) / 10000
}

// ---------------------------------------------------------------------
// placeAlongRoute -- the placement math
// ---------------------------------------------------------------------
//
// geometry: [[lon,lat], [lon,lat], ...], exactly the shape lane_routes.
// geometry (034) stores. existing: {lat,lon}[] of facilities already
// known -- from an earlier call in the same generation run, or read back
// from the database -- a candidate within mergeRadiusMi of one of these
// is dropped rather than duplicated, so the corridor's facilities are
// SHARED across every route that passes near them, the way a real
// traveler shares the world's truck stops with everyone else on the same
// highway.
//
// Returns [{lat, lon}] for the NEW points this one route needs. The
// caller (scripts/generate-facilities.js) is expected to fold each
// accepted point into its own running `existing` list before placing the
// next route, so two routes placed in the same run also share a corridor
// -- not just a route placed against rows already in the database.
// Walks every spacing-interval boundary along `geometry`, IN ORDER, with
// no dedupe -- the raw candidate stream placeAlongRoute filters and
// countTargetPoints just counts are both built on this one walk, so the
// two can never disagree about where a route's boundaries fall.
//
// Walks by CUMULATIVE distance, not by coordinate index -- an OSRM
// geometry's segments are wildly unequal (a straight interstate stretch
// is one long segment, a cloverleaf is a dozen short ones), so "every Nth
// point" would bunch facilities at interchanges and starve the open road
// between them. coveredMi tracks how far the walk has gone; nextTargetMi
// is the next spacing boundary to place a stop at.
function* walkTargets(geometry, spacingMi) {
  if (!Array.isArray(geometry) || geometry.length < 2 || !(spacingMi > 0)) return

  let coveredMi = 0
  let nextTargetMi = spacingMi
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const [lon1, lat1] = geometry[i]
    const [lon2, lat2] = geometry[i + 1]
    const segMi = haversineMi({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 })
    if (!(segMi > 0)) continue

    // A `while`, not an `if`: one long OSRM segment can contain several
    // spacing boundaries at once (a 600mi interstate stretch with
    // SPACING_MI=193 crosses THREE of them), and an `if` would silently
    // place only the first and skip the rest.
    while (nextTargetMi <= coveredMi + segMi) {
      const f = (nextTargetMi - coveredMi) / segMi
      yield { lat: lat1 + (lat2 - lat1) * f, lon: lon1 + (lon2 - lon1) * f }
      nextTargetMi += spacingMi
    }
    coveredMi += segMi
  }
}

export function placeAlongRoute(geometry, { spacingMi = SPACING_MI, mergeRadiusMi = MERGE_RADIUS_MI, existing = [] } = {}) {
  const accepted = []
  function isNear(lat, lon) {
    for (const p of existing) {
      if (haversineMi({ lat, lon }, p) <= mergeRadiusMi) return true
    }
    for (const p of accepted) {
      if (haversineMi({ lat, lon }, p) <= mergeRadiusMi) return true
    }
    return false
  }

  for (const { lat, lon } of walkTargets(geometry, spacingMi)) {
    if (!isNear(lat, lon)) {
      accepted.push({ lat: round4(lat), lon: round4(lon) })
    }
  }

  return accepted
}

// How many spacing boundaries `geometry` crosses, with NO dedupe --
// scripts/generate-facilities.js's report subtracts placeAlongRoute's
// accepted.length from this per route to say how many candidates were
// merged into a facility that already existed, without placeAlongRoute
// itself having to change its return shape (a plain new-points array) to
// carry that count.
export function countTargetPoints(geometry, spacingMi = SPACING_MI) {
  let n = 0
  for (const _point of walkTargets(geometry, spacingMi)) n += 1
  return n
}

// ---------------------------------------------------------------------
// Identity -- a stable id, and a per-facility PRNG seeded from it
// ---------------------------------------------------------------------

// FNV-1a, a standard 32-bit non-cryptographic string hash (not invented
// here) -- used only to turn a stable text key into a numeric PRNG seed,
// never for anything security-sensitive.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// The same standard mulberry32 as scripts/seed/build.js and
// test/helpers/rng.js, re-implemented here rather than imported.
// Importing build.js for one function would pull in its whole postings/
// applicants/trucks import graph -- exactly the cycle risk
// marketTargets.js's own header explains for vocabulary/vocabularySchema/
// generate -- for a module that otherwise (like marketTargets.js) needs
// nothing outside itself and cities.js/hos.js/finance.constants.js.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Stable, derived from the point's own rounded coordinates -- not a
// random uuid, so regenerating from the same cached routes reproduces the
// same id for the same real-world spot (see the migration's own header
// for why PRIMARY KEY(id) alone is then enough to forbid a duplicate
// row). toFixed(4) rather than the raw float so two calls with the exact
// same rounded point always format identically.
export function facilityId(lat, lon) {
  return `fac_${lat.toFixed(4)}_${lon.toFixed(4)}`
}

// A PRNG seeded from a facility's own id, so its kind/name/price are
// exactly reproducible for the same point across generation runs,
// regardless of which route or which run order discovered it first --
// the same "one seed decides everything deterministically" discipline as
// scripts/seed/build.js's own mulberry32(seed) at the top of a run, just
// keyed per-facility instead of per-run.
export function facilityRng(id) {
  return mulberry32(fnv1a(id))
}

// ---------------------------------------------------------------------
// Nearest city
// ---------------------------------------------------------------------

// Closest scripts/seed/cities.js CITIES entry by great-circle distance --
// the same closed-set-lookup discipline as routing.service.js's own
// resolveCity, just nearest instead of exact: a facility sits BETWEEN
// cities, so there is no exact match to look up, only a closest one.
export function nearestCity(lat, lon) {
  let best = null
  let bestMi = Infinity
  for (const c of CITIES) {
    const d = haversineMi({ lat, lon }, c)
    if (d < bestMi) {
      bestMi = d
      best = c
    }
  }
  return best
}

// ---------------------------------------------------------------------
// Kind -- what a stop is
// ---------------------------------------------------------------------
//
// Not sourced -- like 013_brokers.sql's credit-rating spread ("Rating
// spread is deliberate..."), this is a stated modeling decision, not a
// measured one. Fuel-selling kinds (fuel + truck_stop) are more than half
// of all stops because fuel is the reason most drivers pull off at all;
// rest_area next because it exists independent of anyone's commerce (a
// state keeps it open whether or not a truck ever stops); repair least
// often, matching how rarely an ordinary stop turns into a service call.
export const FACILITY_KIND_MIX = Object.freeze([
  ['truck_stop', 35],
  ['fuel', 30],
  ['rest_area', 20],
  ['repair', 15],
])

export function pickKind(rng) {
  const total = FACILITY_KIND_MIX.reduce((sum, [, w]) => sum + w, 0)
  let roll = rng() * total
  for (const [kind, weight] of FACILITY_KIND_MIX) {
    roll -= weight
    if (roll < 0) return kind
  }
  return FACILITY_KIND_MIX[FACILITY_KIND_MIX.length - 1][0]
}

// ---------------------------------------------------------------------
// Fuel price
// ---------------------------------------------------------------------
//
// Centered on FUEL_PRICE_PER_GAL (finance.constants.js, $4.05) -- the
// project's own fuel-cost assumption everywhere else (settlements, the
// Finance page's `assumptions{}`). The SPREAD around it is what makes a
// facility's price a dispatcher decision instead of decoration, and it is
// sized from a real number, not guessed:
//
//   EIA "On-Highway Diesel Fuel Prices", data date 2026-09-14 (accessed
//   2026-09-18 via https://www.eia.gov/dnav/pet/pet_pri_gnd_a_epd2d_pte_dpgal_w.htm
//   and corroborated by https://www.ttnews.com/2026-doe-regional-diesel-fuel-prices):
//     national average         $6.285/gal
//     Gulf Coast (PADD3, low)  $6.027/gal
//     West Coast (PADD5, high) $7.250/gal
//   (California's own separate $8.039/gal line is a state-tax outlier,
//   not a PADD region, so it's excluded from the spread below the same
//   way a PADD-level "regional spread" normally would exclude it.)
//
//   FUEL_PRICE_SPREAD_FRACTION = (high - low) / (2 * national average)
//                              = (7.250 - 6.027) / (2 * 6.285)
//                              ~= 0.0973 (+/-9.73%)
//
// Applied to FUEL_PRICE_PER_GAL rather than to the real 2026 diesel price
// itself: FUEL_PRICE_PER_GAL is this project's OWN business constant (see
// finance.constants.js's own header on FIXED_COST_PER_MILE for why these
// are deliberately chosen game numbers, not a live feed), so what this
// file borrows from EIA is the SHAPE of regional variation -- how wide a
// spread real US diesel pricing has, as a fraction of its own average --
// not the absolute 2026 price level, which this project doesn't track.
export const FUEL_PRICE_SPREAD_FRACTION = (7.250 - 6.027) / (2 * 6.285)

export function fuelPriceCents(rng) {
  const lo = FUEL_PRICE_PER_GAL * (1 - FUEL_PRICE_SPREAD_FRACTION)
  const hi = FUEL_PRICE_PER_GAL * (1 + FUEL_PRICE_SPREAD_FRACTION)
  return Math.round((lo + rng() * (hi - lo)) * 100)
}

// ---------------------------------------------------------------------
// Amenities
// ---------------------------------------------------------------------

const AMENITIES_BY_KIND = Object.freeze({
  fuel: ['parking', 'restrooms', 'atm'],
  truck_stop: ['parking', 'showers', 'restrooms', 'scales', 'wifi', 'restaurant', 'atm', 'tire-service'],
  rest_area: ['parking', 'restrooms', 'vending'],
  repair: ['parking', 'restrooms', 'tire-service', 'towing'],
})

export function pickAmenities(rng, kind) {
  const pool = AMENITIES_BY_KIND[kind] ?? []
  return pool.filter(() => rng() < 0.6)
}

// ---------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------
//
// `pool` is TRUCK_STOP_NAMES or REPAIR_SHOP_NAMES (scripts/seed/
// vocabulary.js) -- already vetted, once, by scripts/seed/
// vocabularySchema.js's validateVocabulary() against BANNED_BRAND
// (scripts/seed/validate.js: Pilot, Flying J, Love's, TA, TravelCenters,
// Petro, QuikTrip, Buc-ee's, Sapp Bros, Roady's -- real companies this
// project must never claim to be). Picking here does not re-check that;
// it trusts the same gate generate.js already trusts COMMODITIES through.
//
// Picks a name from `pool` not already in `used` (per-route dedupe, so
// one corridor's stops don't repeat a name the way generateTruckListing's
// note draw refuses to repeat a service note within one listing). Bounded
// by pool.length tries -- vocabularySchema.js sizes TRUCK_STOP_NAMES/
// REPAIR_SHOP_NAMES at MAX_STOPS_PER_ROUTE so this always finds one
// before running out, but the bound keeps a shrunk or hand-edited list
// from looping forever instead of just repeating.
export function pickUnusedName(rng, pool, used) {
  for (let tries = 0; tries < pool.length; tries += 1) {
    const candidate = pool[Math.floor(rng() * pool.length)]
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  // Pool exhausted for this route -- every name already used once. Repeat
  // rather than throw: a route longer than the pool is sized for is a
  // sign the sizing assumption changed (see MAX_STOPS_PER_ROUTE), not a
  // reason to fail a whole generation run over one long lane.
  return pool[Math.floor(rng() * pool.length)]
}

// rest_area names are structural (nearest city + "Rest Area"), not drawn
// from a vocabulary list -- a state DOT names its own rest areas after
// the nearest town or a geographic feature, never a brand, so there is no
// brand-name risk here to guard against, and no need for a name pool
// sized by MAX_STOPS_PER_ROUTE. `used` still dedupes within one route:
// two stops near the same city on a long lane get " #2", " #3", ...
// rather than reading as the exact same rest area twice.
export function restAreaName(nearCityName, used) {
  const base = `${nearCityName} Rest Area`
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  let candidate = `${base} #${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${base} #${n}`
  }
  used.add(candidate)
  return candidate
}

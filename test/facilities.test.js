// Facility placement/naming/pricing: pure functions, no database, no
// network. Each test names the mutation it kills, the same convention
// routing.test.js/laneSearch.test.js/tracking.test.js already use.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  placeAlongRoute, countTargetPoints, SPACING_MI, MERGE_RADIUS_MI,
  MAX_STOPS_PER_ROUTE, AVG_HIGHWAY_MPH, DAILY_DRIVE_MI,
  facilityId, facilityRng, nearestCity, pickKind, fuelPriceCents,
  FUEL_PRICE_SPREAD_FRACTION, pickUnusedName, restAreaName,
} from '../scripts/seed/facilities.js'
import { validateVocabulary } from '../scripts/seed/vocabularySchema.js'
import { BUILT_IN, TRUCK_STOP_NAMES, REPAIR_SHOP_NAMES } from '../scripts/seed/vocabulary.js'
import { BANNED_TRUCK_STOP_BRANDS, BANNED_BRAND } from '../scripts/seed/validate.js'
import { DRIVING_LIMIT_HOURS } from '../src/constants/hosClock.js'
import { FUEL_PRICE_PER_GAL } from '../src/modules/finance/finance.constants.js'
import { CITIES, haversineMi } from '../scripts/seed/cities.js'

// ---------------------------------------------------------------------
// SPACING_MI / MERGE_RADIUS_MI -- derived, not typed in
// ---------------------------------------------------------------------

test('SPACING_MI is derived from DRIVING_LIMIT_HOURS (the 11-hour driving cap), not the 14-hour duty window', () => {
  // Recomputes the formula independently rather than asserting a literal
  // 151 -- the same "the minimums are derived, not typed in" discipline
  // vocabulary.test.js already applies to vocabularySchema.js. If someone
  // changes DRIVING_LIMIT_HOURS or AVG_HIGHWAY_MPH without touching this
  // test, the test still passes -- what it guards is the FORMULA, not a
  // number that happened to fall out of it today.
  //
  // THE BUG THIS TEST REPLACES: this file used to import
  // DRIVING_HOURS_PER_DAY (= 24 - REQUIRED_REST_HOURS = 14, the DUTY
  // WINDOW) and assert DAILY_DRIVE_MI against IT. 14 was never a driving
  // cap -- see hosClock.js's own header. DAILY_DRIVE_MI is now pinned
  // against DRIVING_LIMIT_HOURS (11, 49 CFR 395.3(a)(3)) instead, and
  // that export is gone from facilities.js entirely.
  assert.equal(AVG_HIGHWAY_MPH, 55)
  assert.equal(DRIVING_LIMIT_HOURS, 11)
  assert.equal(DAILY_DRIVE_MI, DRIVING_LIMIT_HOURS * AVG_HIGHWAY_MPH)
  assert.equal(DAILY_DRIVE_MI, 605)
  const stopsPerDrivingDay = 4
  assert.equal(SPACING_MI, Math.round(DAILY_DRIVE_MI / stopsPerDrivingDay))
})

test('MERGE_RADIUS_MI sits well under half of SPACING_MI', () => {
  // The property that actually matters (facilities.js's own header): two
  // stops the generator deliberately placed a full SPACING_MI apart must
  // never be close enough to merge into one, or the spacing computed
  // above means nothing.
  assert.ok(MERGE_RADIUS_MI < SPACING_MI / 2, `merge radius ${MERGE_RADIUS_MI} too close to half of spacing ${SPACING_MI}`)
  assert.equal(MERGE_RADIUS_MI, Math.round(SPACING_MI / 8))
})

test('MAX_STOPS_PER_ROUTE is the longest cached route divided by SPACING_MI', () => {
  // 4000 is lane_routes_distance_range's own ceiling (034) -- restated
  // here as a literal because facilities.js's own comment already cites
  // the migration; a test importing the migration's SQL to re-derive it
  // would be checking a string, not a number.
  assert.equal(MAX_STOPS_PER_ROUTE, Math.ceil(4000 / SPACING_MI))
})

// ---------------------------------------------------------------------
// placeAlongRoute -- walks by distance, not by coordinate index
// ---------------------------------------------------------------------

test('placeAlongRoute: UNEQUAL segments place stops by distance, not by index', () => {
  // One long segment (~579mi, more than 2x SPACING_MI) then one short one
  // (~35mi). THE MUTATION this kills: an index-based placer (one stop per
  // coordinate pair, or "every Nth vertex") would either place nothing on
  // the long segment or misplace stops relative to where the mileage
  // actually falls.
  const DALLAS = [-96.7970, 32.7767]
  const FAR_NORTH = [-96.7970, 40.0] // due north of Dallas, ~500mi
  const NEAR_FAR_NORTH = [-96.7970, 40.5] // ~35mi further

  const geometry = [DALLAS, FAR_NORTH, NEAR_FAR_NORTH]
  const candidates = placeAlongRoute(geometry, { spacingMi: 100, mergeRadiusMi: 5, existing: [] })

  assert.ok(candidates.length >= 4, `expected several stops on a ~535mi path at 100mi spacing, got ${candidates.length}`)

  // Every candidate must land ON the path (between Dallas's latitude and
  // the far end's), not off to the side or repeated at one spot -- an
  // index-based bug tends to either collapse everything onto one vertex
  // or skip the long segment outright.
  for (const c of candidates) {
    assert.ok(c.lat > DALLAS[1] && c.lat <= 40.5, `candidate lat ${c.lat} not on the path`)
  }

  // Distances between consecutive accepted stops should be close to the
  // 100mi spacing asked for (allowing for the interpolation landing
  // between exact multiples near the end) -- not bunched at zero
  // (everything on one vertex) and not wildly larger (skipped stops).
  for (let i = 1; i < candidates.length; i += 1) {
    const gap = haversineMi(candidates[i - 1], candidates[i])
    assert.ok(gap > 50 && gap < 150, `gap between stop ${i - 1} and ${i} was ${gap}mi, expected ~100mi`)
  }
})

test('placeAlongRoute: a single long segment crosses SEVERAL spacing boundaries', () => {
  // THE MUTATION this kills: an `if` instead of the `while` in
  // walkTargets would place at most one stop per segment, silently
  // dropping every boundary after the first on a long straight highway.
  const geometry = [[-96.0, 30.0], [-96.0, 36.0]] // ~415mi due north
  const candidates = placeAlongRoute(geometry, { spacingMi: 100, mergeRadiusMi: 5, existing: [] })
  assert.ok(candidates.length >= 4, `expected >=4 stops on a ~415mi single segment at 100mi spacing, got ${candidates.length}`)
})

test('placeAlongRoute: an N-mile route produces roughly N / spacingMi stops', () => {
  // ~2000mi due north from a Gulf Coast latitude -- comfortably inside
  // CONUS start/end, long enough to be many multiples of SPACING_MI.
  const geometry = [[-96.0, 26.0], [-96.0, 55.0]]
  const totalMi = haversineMi({ lat: 26.0, lon: -96.0 }, { lat: 55.0, lon: -96.0 })
  const candidates = placeAlongRoute(geometry, { existing: [] }) // default SPACING_MI/MERGE_RADIUS_MI
  const expected = Math.floor(totalMi / SPACING_MI)
  assert.ok(Math.abs(candidates.length - expected) <= 1,
    `expected ~${expected} stops for a ${totalMi.toFixed(0)}mi route at ${SPACING_MI}mi spacing, got ${candidates.length}`)
})

// ---------------------------------------------------------------------
// Dedupe -- a point within mergeRadiusMi of an existing one is reused
// ---------------------------------------------------------------------

test('placeAlongRoute: a candidate within mergeRadiusMi of an existing facility is NOT recreated', () => {
  const geometry = [[-96.0, 30.0], [-96.0, 34.0]] // ~276mi due north
  const bare = placeAlongRoute(geometry, { spacingMi: 100, mergeRadiusMi: 10, existing: [] })
  assert.ok(bare.length >= 2, 'need at least two stops to test dedupe against one of them')

  // Seed `existing` with a point a couple miles from the SECOND bare
  // candidate (well inside a 10mi merge radius) -- THE MUTATION this
  // kills: a merge check that compares against `existing` by exact
  // equality (or is skipped entirely) would place a new stop right next
  // to one that already exists.
  const nearSecond = { lat: bare[1].lat + 0.02, lon: bare[1].lon } // ~1.4mi north
  const deduped = placeAlongRoute(geometry, { spacingMi: 100, mergeRadiusMi: 10, existing: [nearSecond] })

  assert.equal(deduped.length, bare.length - 1,
    'exactly the one candidate near the seeded existing point should be dropped')
  for (const c of deduped) {
    const gap = haversineMi(c, nearSecond)
    assert.ok(gap > 10, `a deduped candidate at ${gap.toFixed(1)}mi from the existing point should have been dropped`)
  }
})

test('placeAlongRoute: candidates ACCEPTED earlier on the same route also dedupe against each other', () => {
  // A "there and back" geometry, constructed so the walk revisits the
  // EXACT same physical point: P0 -> P1 (exactly 2*spacingMi away) -> P0.
  // Spacing boundaries land at spacingMi (the midpoint, outbound) and at
  // 3*spacingMi (the SAME midpoint, on the way back) -- cum=2*spacingMi
  // itself lands exactly on P1, the turnaround. THE MUTATION this kills:
  // a placer that only checks new candidates against `existing` (never
  // against points it has already accepted THIS call) would plant a
  // second facility on top of the first when a route loops back on
  // itself, which a real interstate cloverleaf/frontage-road geometry can
  // do.
  const spacingMi = 50
  // Offset in degrees latitude such that haversineMi(P0, P1) is exactly
  // 2*spacingMi (100mi) -- found once, not a round number typed in.
  const offsetDeg = 1.4473016952885283
  const P0 = [0, 30.0] // [lon, lat]
  const P1 = [0, 30.0 + offsetDeg]
  const geometry = [P0, P1, P0]

  const candidates = placeAlongRoute(geometry, { spacingMi, mergeRadiusMi: 5, existing: [] })

  // Without self-dedupe there would be 3 boundaries (spacingMi, 2*spacingMi,
  // 3*spacingMi); with it, the 3rd collapses into the 1st.
  assert.equal(candidates.length, 2, `expected the outbound midpoint and the turnaround only, got ${candidates.length}: ${JSON.stringify(candidates)}`)

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const gap = haversineMi(candidates[i], candidates[j])
      assert.ok(gap > 5, `two accepted candidates only ${gap.toFixed(1)}mi apart`)
    }
  }
})

test('countTargetPoints matches placeAlongRoute\'s count when nothing is deduped', () => {
  const geometry = [[-96.0, 28.0], [-96.0, 41.0]]
  const withNoExisting = placeAlongRoute(geometry, { spacingMi: 150, mergeRadiusMi: 10, existing: [] })
  assert.equal(countTargetPoints(geometry, 150), withNoExisting.length)
})

// ---------------------------------------------------------------------
// Identity and per-facility determinism
// ---------------------------------------------------------------------

test('facilityId is the same for the same rounded point, every call', () => {
  assert.equal(facilityId(32.77669, 96.79701), facilityId(32.77669, 96.79701))
  // 0.001 degrees (~230ft at this latitude) is well outside toFixed(4)'s
  // own rounding noise -- a real different point must get a real
  // different id.
  assert.notEqual(facilityId(32.77669, 96.79701), facilityId(32.77769, 96.79701))
})

test('facilityRng(id) produces the exact same sequence for the same id', () => {
  const id = facilityId(35.1495, -90.0490)
  const a = facilityRng(id)
  const b = facilityRng(id)
  const seqA = [a(), a(), a()]
  const seqB = [b(), b(), b()]
  assert.deepEqual(seqA, seqB)
})

test('nearestCity finds the closest CITIES entry, not just any close one', () => {
  const dallas = CITIES.find((c) => c.city === 'Dallas')
  // A point a fraction of a degree from Dallas is closer to Dallas than
  // to anything else in the closed set.
  const near = nearestCity(dallas.lat + 0.05, dallas.lon - 0.05)
  assert.equal(near.city, 'Dallas')
  assert.equal(near.state, 'TX')
})

// ---------------------------------------------------------------------
// Fuel price -- stable per seed, inside the computed EIA-derived band
// ---------------------------------------------------------------------

test('fuelPriceCents is stable for the same facility id', () => {
  const id = facilityId(29.7604, -95.3698)
  const priceA = fuelPriceCents(facilityRng(id))
  const priceB = fuelPriceCents(facilityRng(id))
  assert.equal(priceA, priceB)
})

test('fuelPriceCents lands inside FUEL_PRICE_PER_GAL +/- the EIA-derived spread', () => {
  const lo = Math.round(FUEL_PRICE_PER_GAL * (1 - FUEL_PRICE_SPREAD_FRACTION) * 100)
  const hi = Math.round(FUEL_PRICE_PER_GAL * (1 + FUEL_PRICE_SPREAD_FRACTION) * 100)
  assert.ok(FUEL_PRICE_SPREAD_FRACTION > 0 && FUEL_PRICE_SPREAD_FRACTION < 0.5,
    `spread fraction ${FUEL_PRICE_SPREAD_FRACTION} looks made up, not derived from EIA's regional numbers`)
  for (let i = 0; i < 500; i += 1) {
    const id = facilityId(30 + i * 0.01, -95)
    const cents = fuelPriceCents(facilityRng(id))
    assert.ok(cents >= lo && cents <= hi, `${cents} outside [${lo}, ${hi}]`)
  }
})

// ---------------------------------------------------------------------
// Names -- real brand names are refused
// ---------------------------------------------------------------------

test('a real truck-stop brand name is rejected by validateVocabulary', () => {
  for (const brand of ['Pilot', 'Flying J', "Love's", 'TA', 'QuikTrip']) {
    const vocab = JSON.parse(JSON.stringify(BUILT_IN))
    vocab.TRUCK_STOP_NAMES = [...vocab.TRUCK_STOP_NAMES.slice(1), `${brand} Travel Center`]
    const { ok, errors } = validateVocabulary(vocab)
    assert.equal(ok, false, `"${brand} Travel Center" should have been rejected`)
    assert.ok(errors.some((e) => e.includes('TRUCK_STOP_NAMES') && e.includes("taqiqlangan brend")),
      `expected a banned-brand error for "${brand}", got: ${JSON.stringify(errors)}`)
  }
})

test('a real repair-chain brand name is rejected by validateVocabulary', () => {
  const vocab = JSON.parse(JSON.stringify(BUILT_IN))
  vocab.REPAIR_SHOP_NAMES = [...vocab.REPAIR_SHOP_NAMES.slice(1), "Love's Truck Care"]
  const { ok, errors } = validateVocabulary(vocab)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('REPAIR_SHOP_NAMES') && e.includes("taqiqlangan brend")))
})

test('BANNED_BRAND matches every listed brand and nothing that merely resembles one', () => {
  for (const brand of BANNED_TRUCK_STOP_BRANDS) {
    assert.ok(BANNED_BRAND.test(`${brand} Fuel Stop`), `should match "${brand}"`)
  }
  // Ordinary invented names that share no whole word with a brand must
  // pass clean -- a substring match (rather than word-boundary) would
  // false-positive on words that merely CONTAIN a brand's letters.
  assert.equal(BANNED_BRAND.test('Cedar Ridge Travel Plaza'), false)
  assert.equal(BANNED_BRAND.test('Stonegate Travel Plaza'), false)
})

test('the shipped TRUCK_STOP_NAMES/REPAIR_SHOP_NAMES pass their own schema', () => {
  const { ok, errors } = validateVocabulary(BUILT_IN)
  assert.deepEqual(errors, [])
  assert.ok(ok)
})

test('pickUnusedName never repeats a name within one route while the pool allows it', () => {
  const used = new Set()
  const rng = facilityRng('test-seed-pick-unused')
  const drawn = []
  const poolSize = Math.min(TRUCK_STOP_NAMES.length, 10)
  for (let i = 0; i < poolSize; i += 1) {
    drawn.push(pickUnusedName(rng, TRUCK_STOP_NAMES, used))
  }
  assert.equal(new Set(drawn).size, drawn.length, `expected ${drawn.length} distinct names, got repeats: ${JSON.stringify(drawn)}`)
})

test('restAreaName disambiguates repeats within one route with a numbered suffix', () => {
  const used = new Set()
  const first = restAreaName('Dallas', used)
  const second = restAreaName('Dallas', used)
  const third = restAreaName('Dallas', used)
  assert.equal(first, 'Dallas Rest Area')
  assert.equal(second, 'Dallas Rest Area #2')
  assert.equal(third, 'Dallas Rest Area #3')
  assert.equal(new Set([first, second, third]).size, 3)
})

// ---------------------------------------------------------------------
// Name list sizing -- long enough that the longest route can't force a repeat
// ---------------------------------------------------------------------

test('TRUCK_STOP_NAMES and REPAIR_SHOP_NAMES are each at least MAX_STOPS_PER_ROUTE long', () => {
  assert.ok(TRUCK_STOP_NAMES.length >= MAX_STOPS_PER_ROUTE,
    `${TRUCK_STOP_NAMES.length} names, need >= ${MAX_STOPS_PER_ROUTE} (the longest cached route's worst case)`)
  assert.ok(REPAIR_SHOP_NAMES.length >= MAX_STOPS_PER_ROUTE,
    `${REPAIR_SHOP_NAMES.length} names, need >= ${MAX_STOPS_PER_ROUTE}`)
})

// ---------------------------------------------------------------------
// Kind mix -- every kind in FACILITY_KIND_MIX is reachable
// ---------------------------------------------------------------------

test('pickKind produces all four kinds over enough draws, never anything else', () => {
  const rng = facilityRng('kind-mix-coverage-seed')
  const seen = new Set()
  for (let i = 0; i < 1000; i += 1) seen.add(pickKind(rng))
  assert.deepEqual([...seen].sort(), ['fuel', 'repair', 'rest_area', 'truck_stop'])
})

// ---------------------------------------------------------------------
// City rings -- stops that do not depend on a cached lane
// ---------------------------------------------------------------------
import {
  placeAroundCity, offsetPoint, mulberry32, fnv1aSeed,
  CITY_STOPS_MIN, CITY_STOPS_MAX, CITY_RING_MIN_MI, CITY_RING_MAX_MI,
} from '../scripts/seed/facilities.js'

const haversine = haversineMi
const DALLAS = CITIES.find((c) => c.city === 'Dallas' && c.state === 'TX')
const ringFor = (city, opts = {}) =>
  placeAroundCity(city, { rng: mulberry32(fnv1aSeed(`${city.city}, ${city.state}`)), ...opts })

// Kills: offsetting by degrees instead of miles, or forgetting that a
// degree of longitude shrinks with latitude.
test('offsetPoint moves the stated number of miles, north and east', () => {
  const north = offsetPoint(40, -100, 0, 50)
  const east = offsetPoint(40, -100, Math.PI / 2, 50)
  assert.ok(Math.abs(haversine({ lat: 40, lon: -100 }, north) - 50) < 0.5)
  assert.ok(Math.abs(haversine({ lat: 40, lon: -100 }, east) - 50) < 0.5)
  assert.ok(north.lat > 40 && Math.abs(north.lon + 100) < 1e-9, 'due north keeps the longitude')
  assert.ok(east.lon > -100, 'due east increases the longitude')
})

// Kills: a ring that lands on the city itself, or scattered across the
// country -- both bounds are the corridor numbers this file derives.
test('a city ring sits between the merge radius and half the corridor spacing', () => {
  for (const city of CITIES.slice(0, 12)) {
    for (const p of ringFor(city)) {
      const mi = haversine(city, p)
      assert.ok(mi >= CITY_RING_MIN_MI - 1 && mi <= CITY_RING_MAX_MI + 1,
        `${city.city}: a stop ${mi.toFixed(1)}mi out is outside [${CITY_RING_MIN_MI}, ${CITY_RING_MAX_MI}]`)
    }
  }
})

// Kills: a count outside the stated range, or a ring that is always the
// same size.
test('a city gets between CITY_STOPS_MIN and CITY_STOPS_MAX stops, and not always the same number', () => {
  const counts = CITIES.map((c) => ringFor(c).length)
  for (const n of counts) assert.ok(n >= 0 && n <= CITY_STOPS_MAX, `${n} stops is outside the range`)
  assert.ok(Math.max(...counts) >= CITY_STOPS_MIN, 'no city reached the minimum -- the draw is broken')
  assert.ok(new Set(counts).size > 1, 'every city drew the same number')
  // Kills a fixed count: with a real draw some city must exceed the floor.
  assert.ok(Math.max(...counts) > CITY_STOPS_MIN, 'no city drew more than the minimum -- the count is not being drawn')
})

// Kills: a non-deterministic ring (a re-run would insert a second set of
// stops beside the first).
test('the same city always produces the same ring', () => {
  assert.deepEqual(ringFor(DALLAS), ringFor(DALLAS))
})

// Kills: dropping the dedupe -- a city stop landing on a corridor stop.
test('a city stop inside the merge radius of a known point is dropped', () => {
  const plain = ringFor(DALLAS)
  assert.ok(plain.length > 0)
  const blocked = ringFor(DALLAS, { existing: plain })
  assert.deepEqual(blocked, [], 'every point of its own ring blocks it the second time')
})

// Kills: a ring that ignores the whole country -- every city must get
// its own, so the map is not empty where no lane has been warmed.
test('every seed city can place at least one stop on an empty map', () => {
  const existing = []
  let total = 0
  for (const city of CITIES) {
    const points = ringFor(city, { existing })
    total += points.length
    existing.push(...points)
  }
  assert.ok(total >= CITIES.length, `only ${total} stops for ${CITIES.length} cities`)
})

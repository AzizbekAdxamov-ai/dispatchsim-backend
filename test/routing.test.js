// Real routing: the geometry-along-a-path math and the OSRM response
// parsing, both exercised with no network reached. Each test names the
// mutation it kills, matching laneSearch.test.js/tracking.test.js's own
// convention.
//
// fetchRoutes() is tested by swapping globalThis.fetch for a stub that
// answers with a small fixture shaped like a real OSRM response (per the
// plan: routes[], geometry.coordinates, distance/duration, legs[].steps[]
// .ref) -- the parsing/normalization/ranking logic runs for real, only
// the actual HTTP round trip is replaced. The fixture is restored after
// every test, including on failure, so one broken test can't leak a stub
// into the next.
//
// lane_routes/routing.sql.js's own statements are parse-checked by
// sql-check (registered there as the 'routing' module); routing.service.js
// (cache read, OSRM-then-save) needs a real database and is exercised by
// hand against a local Postgres, not here.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pointAlongPath } from '../src/modules/tracking/position.js'
import { fetchRoutes } from '../src/modules/routing/osrm.js'

// ---------------------------------------------------------------------
// pointAlongPath
// ---------------------------------------------------------------------

// [lon, lat] straight line, Dallas -> due north three times over --
// coordinates chosen as round numbers so segment lengths are exact
// multiples of each other, not real cities (real-city geometry is already
// covered by tracking.test.js's own DALLAS/CHICAGO fixtures).
const STRAIGHT_PATH = [
  [-96.0, 30.0],
  [-96.0, 31.0],
  [-96.0, 32.0],
]

test('pointAlongPath: f=0 is the first coordinate, f=1 is the last', () => {
  const start = pointAlongPath(STRAIGHT_PATH, 0)
  const end = pointAlongPath(STRAIGHT_PATH, 1)
  assert.equal(start.lon, -96.0)
  assert.equal(start.lat, 30.0)
  assert.equal(end.lon, -96.0)
  assert.equal(end.lat, 32.0)
})

test('pointAlongPath: equal segments, f=0.5 lands on the middle coordinate', () => {
  // THE MUTATION: an off-by-one in the accumulation loop (e.g. comparing
  // with > instead of >=, or starting `coveredMi` from the wrong segment)
  // would land this a whole segment away instead of exactly on it.
  const mid = pointAlongPath(STRAIGHT_PATH, 0.5)
  assert.ok(Math.abs(mid.lat - 31.0) < 1e-9, `mid lat ${mid.lat}`)
  assert.ok(Math.abs(mid.lon - -96.0) < 1e-9, `mid lon ${mid.lon}`)
})

test('pointAlongPath: UNEQUAL segments walk by distance, not by index', () => {
  // Three points, but the first segment is roughly 9x the second
  // (~900 mi Dallas->Chicago-ish jump, then a ~100 mi hop). Total path
  // length is close to 1000 mi.
  //
  // THE MUTATION this kills: an index-based implementation would put f=0.5
  // at coordinates[1] -- the END of the long first segment, ~90% of the
  // way there by distance, not half. A truck "half done" on this route is
  // still deep in the long leg, nowhere near the short one.
  const DALLAS = [-96.7970, 32.7767]
  const NEAR_CHICAGO = [-87.9, 41.5] // ~900 mi from Dallas
  const CHICAGO = [-87.6298, 41.8781] // ~35 mi further

  const path = [DALLAS, NEAR_CHICAGO, CHICAGO]
  const byIndexWrong = { lon: NEAR_CHICAGO[0], lat: NEAR_CHICAGO[1] }

  const half = pointAlongPath(path, 0.5)

  // Not anywhere near the index-1 coordinate...
  const distFromIndexPoint = Math.hypot(half.lat - byIndexWrong.lat, half.lon - byIndexWrong.lon)
  assert.ok(distFromIndexPoint > 1, `expected far from the index-based point, got ${distFromIndexPoint}`)
  // ...and inside the FIRST (long) segment, past its own midpoint, because
  // the short second segment barely moves the halfway-by-distance point.
  assert.ok(half.lat > DALLAS[1] && half.lat < NEAR_CHICAGO[1])
})

test('pointAlongPath: f is clamped into [0,1]', () => {
  const before = pointAlongPath(STRAIGHT_PATH, -0.5)
  const after = pointAlongPath(STRAIGHT_PATH, 1.5)
  assert.equal(before.lat, 30.0)
  assert.equal(after.lat, 32.0)
})

test('pointAlongPath: a single coordinate returns itself, never NaN', () => {
  const p = pointAlongPath([[-96.0, 32.0]], 0.5)
  assert.equal(p.lat, 32.0)
  assert.equal(p.lon, -96.0)
})

// ---------------------------------------------------------------------
// OSRM response parsing (fetchRoutes), fetch stubbed
// ---------------------------------------------------------------------

function stubFetchOnce(body, { ok = true, status = 200 } = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => body,
  })
  return () => { globalThis.fetch = originalFetch }
}

// Shaped like a real OSRM /route/v1/driving response: routes[], each with
// geometry.coordinates, distance (m), duration (s), legs[].steps[].ref.
function fixtureResponse() {
  return {
    code: 'Ok',
    routes: [
      {
        geometry: { coordinates: [[-96.797, 32.7767], [-95.3698, 29.7604]] },
        distance: 160934.4, // exactly 100 mi
        duration: 5400, // 90 min
        legs: [
          {
            steps: [
              { ref: 'I 45', distance: 120000 },
              { ref: '', distance: 500 }, // unnamed local road -- dropped
              { ref: 'US 59', distance: 30000 },
              { ref: 'I 45', distance: 5000 }, // same ref, second step -- summed
              { ref: 'TX 8', distance: 1000 }, // smallest -- pushed out by MAX_ROAD_REFS
              { ref: 'FM 1960', distance: 900 }, // smaller still -- also dropped
            ],
          },
        ],
      },
    ],
  }
}

test('fetchRoutes: meters -> miles and seconds -> minutes, exact conversion', async () => {
  const restore = stubFetchOnce(fixtureResponse())
  try {
    const [route] = await fetchRoutes({ lat: 32.7767, lon: -96.797 }, { lat: 29.7604, lon: -95.3698 })
    // THE MUTATION: a wrong METERS_PER_MILE (e.g. 1600 or 1609) would drift
    // this off 100 by a visible amount instead of landing exactly on it.
    assert.equal(route.distanceMi, 100)
    assert.equal(route.durationMin, 90)
    assert.deepEqual(route.geometry, [[-96.797, 32.7767], [-95.3698, 29.7604]])
  } finally {
    restore()
  }
})

test('fetchRoutes: refs normalized ("I 45" -> "I-45"), ranked by summed step distance, capped', async () => {
  const restore = stubFetchOnce(fixtureResponse())
  try {
    const [route] = await fetchRoutes({ lat: 32.7767, lon: -96.797 }, { lat: 29.7604, lon: -95.3698 })
    // I-45 total = 120000 + 5000 = 125000 (highest), US-59 = 30000, TX-8 =
    // 1000 and FM-1960 = 900 are both pushed out by the top-3 cap -- and
    // in that exact rank order, not alphabetical or first-seen order.
    //
    // THE MUTATION: normalizeRef's regex not firing would leave "I 45"
    // (space) in the array instead of "I-45"; summing the WRONG way
    // (keeping only the first occurrence's distance, e.g.) would rank
    // US-59 above I-45 since 30000 > 5000 alone.
    assert.deepEqual(route.roadRefs, ['I-45', 'US-59', 'TX-8'])
  } finally {
    restore()
  }
})

test("fetchRoutes: OSRM's own code !== 'Ok' throws, never returns an empty/partial result", async () => {
  const restore = stubFetchOnce({ code: 'NoRoute', message: 'Impossible route between points' })
  try {
    // THE MUTATION: swallowing this into `return []` would tell a caller
    // "OSRM answered, there is no route on this lane" -- which is a
    // different (false) claim than "OSRM refused this request".
    await assert.rejects(
      () => fetchRoutes({ lat: 32.7767, lon: -96.797 }, { lat: 29.7604, lon: -95.3698 }),
      (err) => {
        assert.equal(err.code, 'ROUTE_UNAVAILABLE')
        assert.equal(err.status, 503)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('fetchRoutes: a non-OK HTTP status also throws ROUTE_UNAVAILABLE', async () => {
  const restore = stubFetchOnce({}, { ok: false, status: 503 })
  try {
    await assert.rejects(
      () => fetchRoutes({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
      (err) => {
        assert.equal(err.code, 'ROUTE_UNAVAILABLE')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('fetchRoutes: caps at 3 alternatives even if OSRM returned more', async () => {
  const body = fixtureResponse()
  const extra = { ...body.routes[0] }
  body.routes = [body.routes[0], extra, extra, extra, extra] // 5 total
  const restore = stubFetchOnce(body)
  try {
    const routes = await fetchRoutes({ lat: 32.7767, lon: -96.797 }, { lat: 29.7604, lon: -95.3698 })
    // THE MUTATION: no slice() would hand 5 rows to saveRoutes(), which
    // would then hit lane_routes_alt_range's CHECK (0..2) on the 4th row
    // -- a database constraint doing this function's job, badly, three
    // steps downstream of the actual bug.
    assert.equal(routes.length, 3)
  } finally {
    restore()
  }
})

// Where a truck is on its lane, computed rather than stored.
//
// The position is a VISUAL, but three numbers hang off it -- progress,
// miles remaining, lateness -- and a wrong arc or a wrong clamp makes the
// map disagree with the miles. Each test names the mutation it kills.
//
// Pure-function tests only; the SQL behind the endpoint is parse-checked
// by sql-check (the tracking repository's export is registered there).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  laneEndpoints, interpolateGreatCircle, positionFor,
} from '../src/modules/tracking/position.js'
import { shapeBoard, mapReference } from '../src/modules/tracking/tracking.service.js'
import { CITIES } from '../scripts/seed/cities.js'

// Two cities far apart, on real coordinates -- Dallas and Chicago.
const DALLAS = { lat: 32.7767, lon: -96.797 }
const CHICAGO = { lat: 41.8781, lon: -87.6298 }

test('laneEndpoints resolves real cities and returns null for unknown ones', () => {
  const ok = laneEndpoints({
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
  })
  assert.equal(ok.origin.lat, DALLAS.lat)
  assert.equal(ok.origin.lon, DALLAS.lon)
  assert.equal(ok.destination.lat, CHICAGO.lat)
  assert.equal(ok.destination.lon, CHICAGO.lon)

  // THE MUTATION: a null return replaced with a default (0,0) would pin a
  // marker to the Gulf of Guinea instead of leaving the lane unmapped.
  const unknown = laneEndpoints({
    originCity: 'Nowhere', originState: 'XX',
    destinationCity: 'Chicago', destinationState: 'IL',
  })
  assert.equal(unknown.origin, null)
  assert.equal(unknown.destination.lat, CHICAGO.lat)
})

test('interpolateGreatCircle: f=0 is the origin, f=1 is the destination', () => {
  const start = interpolateGreatCircle(DALLAS, CHICAGO, 0)
  const end = interpolateGreatCircle(DALLAS, CHICAGO, 1)
  assert.ok(Math.abs(start.lat - DALLAS.lat) < 1e-6)
  assert.ok(Math.abs(start.lon - DALLAS.lon) < 1e-6)
  assert.ok(Math.abs(end.lat - CHICAGO.lat) < 1e-6)
  assert.ok(Math.abs(end.lon - CHICAGO.lon) < 1e-6)
})

test('interpolateGreatCircle: midpoint is on the sphere, not a naive lerp', () => {
  // THE MUTATION: naive lat/lon lerp gives 37.3274/-92.2134; the sphere
  // gives 37.4156/-92.4922 -- tens of miles apart, and wrong in a
  // direction a dispatcher from Kansas could see. Also degenerate lanes
  // must not produce NaN.
  const mid = interpolateGreatCircle(DALLAS, CHICAGO, 0.5)
  assert.ok(Math.abs(mid.lat - 37.4156) < 1e-3, `mid lat ${mid.lat}`)
  assert.ok(Math.abs(mid.lon - -92.4922) < 1e-3, `mid lon ${mid.lon}`)
  assert.ok(Number.isFinite(mid.lat) && Number.isFinite(mid.lon))

  // Antipodal/same-point guard: no NaN.
  const same = interpolateGreatCircle(DALLAS, DALLAS, 0.5)
  assert.ok(Number.isFinite(same.lat))
})

test('positionFor: halfway through the ETA window, halfway along the lane', () => {
  const now = Date.now()
  const load = {
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    etaAt: new Date(now + 60 * 60 * 1000).toISOString(),
  }
  const pos = positionFor(load, new Date(now))
  assert.ok(Math.abs(pos.progress - 0.5) < 1e-9)
  // Miles remaining follow the same fraction: 460 of 920.
  assert.equal(pos.distanceRemainingMi, 460)
  assert.equal(pos.late, false)
  assert.ok(pos.lat > DALLAS.lat && pos.lat < CHICAGO.lat)
  // The lane's endpoints come back too, so the page can draw the route line.
  assert.equal(pos.origin.lat, DALLAS.lat)
  assert.equal(pos.origin.lon, DALLAS.lon)
  assert.equal(pos.destination.lat, CHICAGO.lat)
  assert.equal(pos.destination.lon, CHICAGO.lon)
})

test('positionFor: past the ETA the marker waits at the destination, flagged late', () => {
  // THE MUTATION: no clamp would extrapolate f past 1 -- a marker sailing
  // into the Atlantic and negative miles remaining, both of which read as
  // the program having lost its mind rather than the truck being late.
  const now = Date.now()
  const load = {
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    etaAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
  }
  const pos = positionFor(load, new Date(now))
  assert.equal(pos.progress, 1)
  assert.equal(pos.distanceRemainingMi, 0)
  assert.equal(pos.late, true)
  assert.ok(Math.abs(pos.lat - CHICAGO.lat) < 1e-4)
})

test('positionFor: before dispatch clamps to the origin', () => {
  // A load whose clock has not started (a re-dispatched row, a clock skew)
  // sits at the origin, not at a negative-fraction point off the map.
  const now = Date.now()
  const load = {
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now + 60 * 60 * 1000).toISOString(),
    etaAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
  }
  const pos = positionFor(load, new Date(now))
  assert.equal(pos.progress, 0)
  assert.equal(pos.distanceRemainingMi, 920)
  assert.equal(pos.late, false)
})

test('positionFor: null for rows the math cannot place', () => {
  // No timestamps (a booked-but-undispatched row) or unmapped cities --
  // both render as "no position", never as a fabricated one.
  const now = Date.now()
  assert.equal(positionFor({
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920, dispatchedAt: null, etaAt: null,
  }, new Date(now)), null)
  assert.equal(positionFor({
    originCity: 'Nowhere', originState: 'XX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now - 1000).toISOString(),
    etaAt: new Date(now + 1000).toISOString(),
  }, new Date(now)), null)
  // A zero-length window would divide by zero; null instead of NaN.
  assert.equal(positionFor({
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now).toISOString(),
    etaAt: new Date(now).toISOString(),
  }, new Date(now)), null)
})

test('positionFor: an open road event freezes progress/miles at the moment it opened', () => {
  // THE MUTATION: computing `f` from the real clock while an event sits
  // open (resolved_at IS NULL) keeps sliding the marker toward the
  // destination even though eta_at hasn't moved -- eta_at only moves when
  // the dispatcher RESOLVES the event (loadEvents.service.js's
  // resolve -> extendEta). A "Stopped" truck that keeps advancing on the
  // map contradicts its own badge.
  const now = Date.now()
  const dispatchedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString()
  const etaAt = new Date(now + 2 * 60 * 60 * 1000).toISOString()
  // The event opened at the halfway point (progress would be 0.5 there).
  const eventOpenedAt = new Date(now - 1000).toISOString()

  const load = {
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt, etaAt, eventOpenedAt,
  }

  const atOpen = positionFor(load, new Date(now - 1000))
  // 30 real minutes pass with the event still open -- the truck should not
  // have moved an inch, because eventOpenedAt (not `now`) still clamps it.
  const later = positionFor(load, new Date(now - 1000 + 30 * 60 * 1000))

  assert.equal(later.progress, atOpen.progress)
  assert.equal(later.distanceRemainingMi, atOpen.distanceRemainingMi)
  assert.equal(later.lat, atOpen.lat)
  assert.equal(later.lon, atOpen.lon)

  // A load with NO open event (the common case) must keep moving normally
  // -- eventOpenedAt only clamps when it is actually set.
  const noEventLoad = { ...load, eventOpenedAt: null }
  const start = positionFor(noEventLoad, new Date(now - 1000))
  const moved = positionFor(noEventLoad, new Date(now - 1000 + 30 * 60 * 1000))
  assert.notEqual(moved.progress, start.progress)
  assert.notEqual(moved.distanceRemainingMi, start.distanceRemainingMi)
})

test('positionFor: `late` still tracks the real clock while frozen by an open event', () => {
  // THE MUTATION: if `late` were computed from the same clamped instant as
  // `f`, a truck stopped by an event past its ETA would read as on-time
  // forever -- the one thing the page needs to keep saying honestly even
  // while the marker itself holds still.
  const now = Date.now()
  const load = {
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    etaAt: new Date(now - 60 * 60 * 1000).toISOString(),
    // Event opened well before the ETA passed.
    eventOpenedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  }
  const pos = positionFor(load, new Date(now))
  assert.equal(pos.late, true)
  // Frozen at the event-open instant: 1 hour into a 2-hour window -> 0.5,
  // not 1 (which the unclamped elapsed time past etaAt would otherwise give).
  assert.ok(Math.abs(pos.progress - 0.5) < 1e-9, `progress ${pos.progress}`)
})

// --- shapeBoard: the service-level split between placed and excluded rows ---

test('shapeBoard: an unmapped-city load is excluded, counted, and never in `loads`', () => {
  // THE MUTATION: .filter(Boolean) used to drop a load positionFor()
  // couldn't place with no trace anywhere -- not in the list, not in meta,
  // not in a log. A load quietly vanishing from the board is the same
  // "silently wrong instead of loudly wrong" failure loadBoard.repository.js's
  // buildBaseCte guards against for the load board itself.
  const now = new Date()
  const rows = [
    {
      id: 'L1',
      originCity: 'Dallas', originState: 'TX',
      destinationCity: 'Chicago', destinationState: 'IL',
      distanceMi: 920,
      dispatchedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      etaAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    },
    {
      // Unmapped destination -- cities.js never seeded this one.
      id: 'L2',
      originCity: 'Dallas', originState: 'TX',
      destinationCity: 'Nowhere', destinationState: 'XX',
      distanceMi: 500,
      dispatchedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      etaAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    },
  ]

  const { positioned, excluded } = shapeBoard(rows, now)

  assert.equal(positioned.length, 1)
  assert.equal(positioned[0].id, 'L1')
  assert.ok(!positioned.some((l) => l.id === 'L2'), 'the unmapped-city load leaked into the placed list')

  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].id, 'L2')
  assert.equal(excluded[0].reason, 'unmapped-city')
})

test('shapeBoard: a bad-eta load (eta_at <= dispatched_at) is excluded with its own reason', () => {
  const now = new Date()
  const rows = [{
    id: 'L3',
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    distanceMi: 920,
    dispatchedAt: now.toISOString(),
    etaAt: now.toISOString(), // not after dispatchedAt -- positionFor refuses this
  }]

  const { positioned, excluded } = shapeBoard(rows, now)

  assert.equal(positioned.length, 0)
  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].id, 'L3')
  assert.equal(excluded[0].reason, 'bad-eta')
})

// --- The map's standing city layer -------------------------------------
//
// These dots are on screen whether or not a truck is moving, so a bad
// coordinate here is visible all the time and correct-looking: a city
// plotted in the wrong state is still a dot on land. The bounds below are
// the continental US envelope -- roughly 24.5 N (Key West) to 49 N (the
// 49th parallel), and -125 W (the Washington coast) to -66.9 W (West
// Quoddy Head, Maine). Nothing in the seed's closed set is in Alaska or
// Hawaii, so anything outside this box is a typo, not a place.
const CONUS = { minLat: 24.0, maxLat: 49.5, minLon: -125.5, maxLon: -66.5 }

test('mapReference ships every seed city, and only the four fields the map draws', () => {
  const { cities } = mapReference()
  assert.equal(cities.length, CITIES.length)
  for (const c of cities) {
    assert.deepEqual(Object.keys(c).sort(), ['city', 'lat', 'lon', 'state'])
  }
})

test('every city on the map sits inside the continental US', () => {
  // Kills the classic coordinate bug: a dropped minus sign on longitude
  // puts Dallas in the Yellow Sea, and on a static layer nobody would
  // read it as a bug -- just an odd-looking map.
  for (const c of mapReference().cities) {
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `${c.city}, ${c.state} has a non-finite coordinate`)
    assert.ok(c.lat >= CONUS.minLat && c.lat <= CONUS.maxLat, `${c.city}, ${c.state} latitude ${c.lat} is outside the continental US`)
    assert.ok(c.lon >= CONUS.minLon && c.lon <= CONUS.maxLon, `${c.city}, ${c.state} longitude ${c.lon} is outside the continental US`)
  }
})

test('no two seed cities share a (city, state) key', () => {
  // laneEndpoints looks a lane up by `${city}, ${state}` -- a duplicate key
  // would make one of them unreachable and its loads silently unmapped.
  const keys = mapReference().cities.map((c) => `${c.city}, ${c.state}`)
  assert.equal(new Set(keys).size, keys.length)
})

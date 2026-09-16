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

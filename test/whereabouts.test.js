// Where a driver is (src/modules/loads/whereabouts.js,
// src/modules/driverChat/livePlace.js).
//
// From the 2026-10-05 external run: Grace was dispatched on a Nashville
// load while the system had her in Seattle and nobody said so -- and the
// reason was that nothing had ever moved a driver. These hold the fixes:
// a delivery leaves the driver at its destination, the dispatch check
// names the empty run, and a driver on a run is where the run has got to.
//
// Every test names the mutation it kills. No database.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliveredTo, emptyRunToPickup, emptyRunCheck } from '../src/modules/loads/whereabouts.js'
import { livePlace, withLivePlace } from '../src/modules/driverChat/livePlace.js'
import { situationLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { findCity, roadMiles } from '../scripts/seed/cities.js'
import { AVG_HIGHWAY_MPH } from '../scripts/seed/facilities.js'

const NOW = new Date('2026-10-05T15:00:00Z')
const H = 3600000
const NASHVILLE_LOAD = { originCity: 'Nashville', originState: 'TN', destinationCity: 'New York', destinationState: 'NY' }

// Kills: a delivery that leaves the driver where they were, or that
// writes a place without coordinates (the board measures DH-O from lat/lon).
test('a delivered load leaves the driver at its destination, with coordinates', () => {
  const ny = findCity('New York', 'NY')
  assert.deepEqual(deliveredTo(NASHVILLE_LOAD), { city: 'New York', state: 'NY', lat: ny.lat, lon: ny.lon, label: 'New York, NY' })
  assert.equal(deliveredTo({ destinationCity: 'Atlantis', destinationState: 'ZZ' }), null)
})

// Kills: a second mileage formula, or a second speed.
test('the empty run is the same road miles and the same speed the rest of the program uses', () => {
  const run = emptyRunToPickup({ city: 'Seattle', state: 'WA' }, NASHVILLE_LOAD)
  assert.equal(run.miles, roadMiles(findCity('Seattle', 'WA'), findCity('Nashville', 'TN')))
  assert.equal(run.hours, run.miles / AVG_HIGHWAY_MPH)
  assert.deepEqual(emptyRunToPickup({ city: 'Nashville', state: 'TN' }, NASHVILLE_LOAD), { miles: 0, hours: 0 })
  assert.equal(emptyRunToPickup({ city: null, state: null }, NASHVILLE_LOAD), null)
})

// Kills: no line for the empty run, a line that fails (blocks) instead
// of warning, or a warning when there is time.
test('the dispatch check names the empty run, and warns when the drive alone outlasts the time to pickup', () => {
  const seattle = { currentCity: 'Seattle', currentState: 'WA' }
  const soon = emptyRunCheck(seattle, { ...NASHVILLE_LOAD, pickupAt: new Date(+NOW + 20 * H) }, NOW)
  assert.equal(soon.state, 'warn')
  assert.match(soon.detail, /^2,\d{3} mi from Seattle, WA -- about \d+h \d{2}m of driving at 55 mph before any rest; pickup is 20h from now$/)
  const later = emptyRunCheck(seattle, { ...NASHVILLE_LOAD, pickupAt: new Date(+NOW + 80 * H) }, NOW)
  assert.equal(later.state, 'ok')
  const past = emptyRunCheck(seattle, { ...NASHVILLE_LOAD, pickupAt: new Date(+NOW - H) }, NOW)
  assert.match(past.detail, /the pickup time has already passed/)
})

// Kills: "0 mi" printed for a driver already at the pickup, or a line
// claiming a distance from a place that is not known.
test('already there, or nowhere known, is said as that', () => {
  assert.equal(emptyRunCheck({ currentCity: 'Nashville', currentState: 'TN' }, NASHVILLE_LOAD, NOW).detail, 'Already in Nashville, TN')
  assert.equal(emptyRunCheck({ currentCity: null, currentState: null }, NASHVILLE_LOAD, NOW).state, 'unknown')
  assert.equal(emptyRunCheck(null, NASHVILLE_LOAD, NOW), null)
})

const RUN = { ...NASHVILLE_LOAD, dispatchedAt: new Date(+NOW - 2 * H), etaAt: new Date(+NOW + 2 * H), distanceMi: 900 }

// Kills: a driver on a run reported where they were parked.
test('a driver on a run is somewhere on the lane, not where they were parked', () => {
  const live = livePlace(RUN, NOW)
  assert.ok(live, 'no place for a run in progress')
  assert.ok(Math.abs(live.progress - 0.5) < 1e-9)
  assert.notDeepEqual([live.city, live.state], ['Nashville', 'TN'])
  assert.notDeepEqual([live.city, live.state], ['New York', 'NY'])
  assert.equal(livePlace({ ...RUN, dispatchedAt: null }, NOW), null)
})

// Kills: losing the parked place (the empty run is measured from it), or
// moving a driver who has no run.
test('the context keeps the parked place and moves only a driver on a run', () => {
  const ctx = { driver: { currentCity: 'Seattle', currentState: 'WA' }, load: RUN }
  const moved = withLivePlace(ctx, NOW).driver
  assert.equal(moved.parkedCity, 'Seattle')
  assert.equal(moved.onTheRoad, true)
  assert.notEqual(moved.currentCity, 'Seattle')
  const idle = withLivePlace({ driver: { currentCity: 'Seattle', currentState: 'WA' }, load: null }, NOW).driver
  assert.equal(idle.currentCity, 'Seattle')
  assert.equal(idle.onTheRoad, false)
  assert.equal(withLivePlace(null, NOW), null)
})

// Kills: the driver told "you are in" a place she is only passing, or
// never told about the empty run her load began with.
test('the driver hears she is on the road, and about the empty miles before the pickup', () => {
  const driver = withLivePlace({ driver: { currentCity: 'Seattle', currentState: 'WA', dutyStatus: 'driving' }, load: RUN }, NOW).driver
  const lines = situationLines({ driver, load: RUN, now: NOW }).join('\n')
  assert.match(lines, /You are on the road near /)
  assert.match(lines, /Before this load you were parked in Seattle, WA\. The pickup in Nashville, TN was about 2,\d{3} road miles from there, all of it empty\./)
  const home = situationLines({ driver: { currentCity: 'Nashville', currentState: 'TN', parkedCity: 'Nashville', parkedState: 'TN', dutyStatus: 'driving' }, load: RUN, now: NOW }).join('\n')
  assert.doesNotMatch(home, /all of it empty/)
})

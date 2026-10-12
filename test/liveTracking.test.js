// A load's Live tracking panel speaks the map's position, not the clock.
// 2026-10-08: load 600010 read "100% complete" while its driver sat in
// open detention at the Nashville dock, mile 0. Each test names the
// mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { liveTracking } from '../src/modules/tracking/liveTracking.js'
import { shapeBoard } from '../src/modules/tracking/tracking.service.js'

const NOW = new Date('2026-10-08T20:06:00Z')
const H = 3600e3

// A board row the way tracking.repository.js returns it.
const row = (over = {}) => ({
  id: '600010', status: 'crit',
  originCity: 'Nashville', originState: 'TN', destinationCity: 'New York', destinationState: 'NY',
  distanceMi: 895, rateUsd: 2828,
  dispatchedAt: new Date(+NOW - 30 * H).toISOString(),
  etaAt: new Date(+NOW - 6 * H).toISOString(),
  eventOpenedAt: null, eventType: null, currentStop: null, routeGeometry: null,
  ...over,
})
const live = (over, extra = {}) => liveTracking({ ...shapeBoard([row(over)], NOW).positioned[0], ...extra }, NOW)

// Kills: the panel using the clock (100%) for a truck the map holds at
// mile 0, or not naming why it is stopped.
test('600010: open detention at dispatch is mile 0, stopped, with the reason', () => {
  const t = live({ eventOpenedAt: new Date(+NOW - 30 * H).toISOString(), eventType: 'detention' })
  assert.equal(t.state, 'event')
  assert.equal(t.milesDone, 0)
  assert.equal(t.fraction, 0)
  assert.equal(t.reason, 'Detention at the dock')
})

// Kills: an ETA in the past read as "arrived" when nothing stops the
// truck -- and "arrived" winning over an open event.
test('past its ETA with nothing open: at the destination, the whole lane done', () => {
  const t = live({})
  assert.equal(t.state, 'arrived')
  assert.equal(t.milesDone, 895)
})

// Kills: a planned stop not reported, or its place dropped.
test('at a planned stop: the stop, where, and since when', () => {
  const arrivedAt = new Date(+NOW - 1 * H).toISOString()
  const t = live({
    etaAt: new Date(+NOW + 10 * H).toISOString(),
    currentStop: { facilityName: "Love's #512", city: 'Knoxville', state: 'TN', reason: 'rest', arrivedAt, lat: 35.96, lon: -83.92 },
  })
  assert.equal(t.state, 'stop')
  assert.equal(t.reason, 'rest')
  assert.deepEqual(t.place, { name: "Love's #512", city: 'Knoxville', state: 'TN' })
  assert.equal(t.since, arrivedAt)
})

// Kills: miles done not following the map's position on a moving truck.
test('moving: miles done is the map\'s share of the lane', () => {
  const t = live({ dispatchedAt: new Date(+NOW - 5 * H).toISOString(), etaAt: new Date(+NOW + 5 * H).toISOString() })
  assert.equal(t.state, 'moving')
  assert.equal(t.milesDone, 895 - Math.round(895 * 0.5))
})

// Kills: lateness computed backwards or rounded away, or measured against
// the posting's real-calendar appointment instead of the run's promise
// (the two calendars differ by design -- see liveTracking.js).
test('the ETA past the promise is stated in minutes, only when it is past', () => {
  const run = { dispatchedAt: new Date(+NOW - 5 * H).toISOString(), etaAt: new Date(+NOW + 5 * H).toISOString() }
  const late = live({ ...run, promisedEtaAt: new Date(+NOW + 2 * H).toISOString() }, { deliveryAt: new Date(+NOW + 99 * H).toISOString() })
  assert.equal(late.etaPastPromiseMin, 180)
  const fine = live({ ...run, promisedEtaAt: new Date(+NOW + 9 * H).toISOString() }, { deliveryAt: new Date(+NOW - 99 * H).toISOString() })
  assert.equal(fine.etaPastPromiseMin, null)
})

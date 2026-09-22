// trips/tripSummary.js -- the planner's numbers. The reference case is a
// real trip-planner screenshot (Baltimore, MD -> Salt Lake City, UT,
// 2,084.9 mi, 31 h 02 min, MPG 6.5, $2.90/gal, $0.40/mi, $15/h, no stops:
// Fuel $930.17, Fixed $1,299.42). The planner rounds its inputs before
// display, so agreement is checked to a few cents, not to the cent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeTrip, legDrivingMinutes, stopMinutes } from '../src/modules/trips/tripSummary.js'

const TRUCK = { maxMph: null, mpg: 6.5, fuelPricePerGal: 2.9, costPerMile: 0.4, costPerHour: 15 }
const W = [{ city: 'Baltimore', state: 'MD' }, { city: 'Salt Lake City', state: 'UT' }]

// Kills: a wrong fuel or fixed-cost formula (e.g. fixed on driving hours
// only, or fuel on gallons without price).
test('matches the reference planner to within a few cents', () => {
  const s = summarizeTrip({ waypoints: W, legs: [{ distanceMi: 2084.9, durationMin: 31 * 60 + 2 }], truck: TRUCK, dutyTimeline: [] })
  assert.equal(s.totals.distanceMi, 2084.9)
  assert.equal(s.totals.drivingMin, 1862)
  assert.ok(Math.abs(s.totals.fuelUsd - 930.17) < 0.05, `fuel ${s.totals.fuelUsd}`)
  assert.ok(Math.abs(s.totals.fixedUsd - 1299.42) < 0.05, `fixed ${s.totals.fixedUsd}`)
  assert.equal(s.totals.tollsUsd, null, 'no toll data -- never a made-up number')
  assert.equal(s.waypoints[1].cumulativeMi, 2084.9)
})

// Kills: ignoring the max-speed cap, or letting it make a leg FASTER.
test('max speed can only slow a leg down', () => {
  assert.equal(legDrivingMinutes({ distanceMi: 600, durationMin: 500 }, 60), 600)
  assert.equal(legDrivingMinutes({ distanceMi: 600, durationMin: 700 }, 60), 700)
  assert.equal(legDrivingMinutes({ distanceMi: 600, durationMin: 500 }, null), 500)
})

// Kills: counting driving as stop time, or leaving the HOS stops out of
// Time and Fixed.
test('HOS stops add to Time and to the hourly part of Fixed', () => {
  const t0 = Date.UTC(2026, 8, 21)
  const H = 3600000
  const timeline = [
    { status: 'driving', startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 8 * H).toISOString() },
    { status: 'off-duty', startedAt: new Date(t0 + 8 * H).toISOString(), endedAt: new Date(t0 + 8.5 * H).toISOString() },
    { status: 'driving', startedAt: new Date(t0 + 8.5 * H).toISOString(), endedAt: new Date(t0 + 11.5 * H).toISOString() },
    { status: 'off-duty', startedAt: new Date(t0 + 11.5 * H).toISOString(), endedAt: new Date(t0 + 21.5 * H).toISOString() },
  ]
  assert.equal(stopMinutes(timeline), 630)
  const s = summarizeTrip({ waypoints: W, legs: [{ distanceMi: 700, durationMin: 660 }], truck: { ...TRUCK, costPerMile: 0 }, dutyTimeline: timeline })
  assert.equal(s.totals.stopsMin, 630)
  assert.equal(s.totals.timeMin, 660 + 630)
  assert.ok(Math.abs(s.totals.fixedUsd - 15 * (1290 / 60)) < 0.01)
})

// Kills: running totals that skip or double a leg.
test('running miles and hours per waypoint add leg by leg', () => {
  const s = summarizeTrip({
    waypoints: [...W, { city: 'Reno', state: 'NV' }],
    legs: [{ distanceMi: 100, durationMin: 100 }, { distanceMi: 50, durationMin: 40 }],
    truck: TRUCK, dutyTimeline: [],
  })
  assert.deepEqual(s.waypoints.map((w) => [w.cumulativeMi, w.cumulativeDrivingMin]), [[0, 0], [100, 100], [150, 140]])
})

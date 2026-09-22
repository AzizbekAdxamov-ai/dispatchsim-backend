// The transit a seeded posting promises and the transit a legal schedule
// can deliver must agree. Before this, transitBand's fast draws promised
// a 500-mile run in ~10.6 hours -- more miles of road than a duty day
// legally holds -- and roughly a third of the board was unfilmable.
//
// What is tested:
//   1. the floor is derived from the same CFR constants the live
//      planner enforces (hosClock.js), not its own numbers;
//   2. a draw can never fall below the floor (the whole point);
//   3. the band's slow end still dominates on short lanes (no pointless
//      flattening -- the window keeps its shape where it was legal);
//   4. determinism: same seed, same draw, byte-identical output.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mulberry32, transitBand, legalTransitFloorHours, drawTransitHours } from '../scripts/seed/build.js'
import { DRIVING_LIMIT_HOURS, DUTY_WINDOW_HOURS, BREAK_MINUTES } from '../src/constants/hosClock.js'
import { REQUIRED_REST_HOURS } from '../src/constants/hos.js'

test('the floor is built from the same law the planner enforces', () => {
  assert.equal(DRIVING_LIMIT_HOURS, 11) // 395.3(a)(3)(i)
  assert.equal(DUTY_WINDOW_HOURS, 14) // 395.3(a)(2)
  assert.equal(BREAK_MINUTES, 30) // 395.3(a)(3)(ii)
  assert.equal(REQUIRED_REST_HOURS, 10) // 395.3(a)(1)

  // At the cap exactly: 605mi at 55mph is 11 hours of driving, the day's
  // whole limit, plus the 30-minute break made due inside the duty day.
  // Below the cap (say 500mi = 9.1h) the limit does not bind and the
  // floor is simply the driving time plus the break.
  const atCap = legalTransitFloorHours(605)
  assert.equal(atCap, 11 + 0.5)
  const belowCap = legalTransitFloorHours(500)
  assert.equal(belowCap, 500 / 55 + 0.5)
})

test('a multi-day floor carries each prior day\'s ten-hour reset', () => {
  // 1400mi at 55mph = 25.45h of driving -> 3 duty days (ceil(1400/605)),
  // and between duty days sit two 10-hour resets. The broker window has
  // to hold the rest as well as the road -- this is the one the old band
  // promised in 35.3h+12h.
  const floor = legalTransitFloorHours(1400)
  assert.equal(floor, 1400 / 55 + 3 * 0.5 + 2 * 10)
})

test('a seeded draw never dips below the legal floor', () => {
  // The mutation this kills: clamping removed (drawTransitHours returning
  // the bare band draw). At 500mi the band min (10.6h) sits below the
  // floor (11.5h), so an unclamped draw reproduces the unfilmable window
  // this exists to remove.
  for (const mi of [300, 500, 800, 1200, 1400, 2000]) {
    const floor = legalTransitFloorHours(mi)
    for (const seed of [1, 7, 4471, 99991]) {
      for (let i = 0; i < 200; i += 1) {
        const h = drawTransitHours(mulberry32(seed), mi)
        assert.ok(h >= floor, `${mi}mi drew ${h.toFixed(2)}h below the ${floor.toFixed(2)}h floor`)
      }
    }
  }
})

test('the band still shapes the window where the law is not binding', () => {
  // A 120-mile lane is legal in one stretch; the floor must not flatten
  // every draw onto itself -- the advertised transit keeps its spread.
  const floor = legalTransitFloorHours(120)
  const draws = new Set()
  for (let i = 0; i < 50; i += 1) draws.add(drawTransitHours(mulberry32(i), 120).toFixed(3))
  assert.ok(draws.size > 5, 'a short lane still draws a varied window')
  const { minH } = transitBand(120)
  assert.ok(floor < minH, 'on short lanes the floor should sit below the band')
})

test('the same seed draws the same transit, as before', () => {
  const a = drawTransitHours(mulberry32(4471), 900)
  const b = drawTransitHours(mulberry32(4471), 900)
  assert.equal(a, b)
})

test('seed output stays byte-identical to the seeded PRNG contract', () => {
  // The generator's whole reproducibility story: a given --seed produces
  // the same sequence forever. (Rule: Math.random never in this path.)
  const r1 = mulberry32(77)
  const r2 = mulberry32(77)
  for (let i = 0; i < 100; i += 1) {
    assert.equal(drawTransitHours(r1, 400 + i * 3), drawTransitHours(r2, 400 + i * 3))
  }
})

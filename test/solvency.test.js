// Whether the company is still a going concern.
//
// The simulator had no failure state. A balance could fall past the
// $50,000 credit line and keep falling -- one session reached -$180,899
// and was dropping $69 every thirty seconds with nothing in transit --
// and nothing anywhere said the company was finished. That removes the
// one lesson the whole cash model exists to teach.
//
// The queries need a database and are parsed by sql:check. What is tested
// here is the valuation and the test itself, both of which can be wrong in
// ways that look entirely normal.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  truckValueUsd, listingPriceUsd,
  MIN_VALUE_USD, MAX_VALUE_USD, NEW_TRUCK_BASE_USD, BASE_YEAR,
} from '../src/constants/truckValue.js'
import { STATES, canCommitNewWork } from '../src/modules/cash/solvency.service.js'
import { seeded } from './helpers/rng.js'

test('a truck loses value with age and with miles, and never goes to zero', () => {
  const newer = truckValueUsd({ year: 2025, odometerMi: 100000 })
  const older = truckValueUsd({ year: 2018, odometerMi: 100000 })
  assert.ok(newer > older, `${newer} vs ${older}`)

  const clean = truckValueUsd({ year: 2022, odometerMi: 200000 })
  const worn = truckValueUsd({ year: 2022, odometerMi: 900000 })
  assert.ok(clean > worn, `${clean} vs ${worn}`)

  // A million-mile truck is worth something. Zero would let a fleet
  // vanish off the balance sheet and tip a solvent company into
  // insolvency on arithmetic alone.
  assert.ok(truckValueUsd({ year: 2015, odometerMi: 3000000 }) >= MIN_VALUE_USD)
})

test('valuation is clamped at both ends', () => {
  assert.equal(truckValueUsd({ year: 1990, odometerMi: 5000000 }), MIN_VALUE_USD)
  assert.ok(truckValueUsd({ year: 2100, odometerMi: 0 }) <= MAX_VALUE_USD)
  // Missing odometer is treated as zero miles, not as NaN. Number(null)
  // is 0 and undefined is NaN -- a NaN here would poison the whole fleet
  // total and make every comparison false.
  const v = truckValueUsd({ year: 2020, odometerMi: undefined })
  assert.ok(Number.isFinite(v) && v > 0, `${v}`)
  assert.equal(v, truckValueUsd({ year: 2020, odometerMi: 0 }))
})

test('the market and the balance sheet use the same model', () => {
  // A listing is book value plus the seller's spread. If these ever came
  // from different formulas, a student could buy a truck for $95,000 and
  // watch their balance sheet value it at something else the same second.
  const rng = seeded(42)
  for (let i = 0; i < 5000; i += 1) {
    const year = 2015 + (i % 11)
    const odometerMi = (i % 90) * 10000
    const book = truckValueUsd({ year, odometerMi })
    const asking = listingPriceUsd({ year, odometerMi, rng })
    // Within the stated spread, or clamped to the same bounds.
    const withinSpread = Math.abs(asking - book) <= 5000
    const clamped = asking === MIN_VALUE_USD || asking === MAX_VALUE_USD
    assert.ok(withinSpread || clamped, `${year}/${odometerMi}: book ${book}, asking ${asking}`)
  }
})

test('a brand new truck is worth about what a new truck costs', () => {
  // Sanity on the anchor itself: the base year at zero miles should land
  // on the base price, not somewhere a reader would have to derive.
  assert.equal(truckValueUsd({ year: BASE_YEAR, odometerMi: 0 }), NEW_TRUCK_BASE_USD)
})

test('only an ok company can take on new work', () => {
  // Past the line the lender has stopped advancing; insolvent, there is
  // nothing to advance against. Neither is the program protecting the
  // student from a choice -- work in transit still finishes and invoices
  // are still collected, which is what a wind-down looks like.
  assert.ok(canCommitNewWork(STATES.OK))
  assert.ok(!canCommitNewWork(STATES.OVER_LIMIT))
  assert.ok(!canCommitNewWork(STATES.INSOLVENT))
  // An unknown state is not a licence to keep spending.
  assert.ok(!canCommitNewWork('something-else'))
  assert.ok(!canCommitNewWork(undefined))
})

test('the three states are distinct strings', () => {
  // If two ever collapsed, a company would silently skip a stage --
  // straight from solvent to finished with no warning in between.
  assert.equal(new Set(Object.values(STATES)).size, 3)
})

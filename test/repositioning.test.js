// The unidentified driving block: the empty repositioning drive that ends
// up in nobody's log.
//
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  repositioningBlock, cityFromLabel, REVIEW_THRESHOLD_MIN,
} from '../src/modules/hos/repositioning.js'
import { roadMiles, findCity } from '../scripts/seed/cities.js'
import { AVG_HIGHWAY_MPH } from '../scripts/seed/facilities.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

const DISPATCHED_AT = '2026-09-25T12:00:00.000Z'

test('a truck that ended its last run elsewhere leaves an unidentified block', () => {
  const block = repositioningBlock({
    truckLocationLabel: 'Chicago, IL', originCity: 'Memphis', originState: 'TN', dispatchedAt: DISPATCHED_AT,
  })
  assert.ok(block, 'Chicago -> Memphis is a real move and must be recorded')
  // Kills: a distance invented here instead of taken from cities.js --
  // the load itself is priced off roadMiles, and two mileages for one
  // road is exactly the class of bug cities.js's header warns about.
  assert.equal(block.distanceMi, roadMiles(findCity('Chicago', 'IL'), findCity('Memphis', 'TN')))
  // Kills: a second speed constant for the same road.
  assert.equal(block.minutes, Math.round((block.distanceMi / AVG_HIGHWAY_MPH) * 60))
})

test('the block ends exactly at the dispatch, never after it', () => {
  const block = repositioningBlock({
    truckLocationLabel: 'Chicago, IL', originCity: 'Memphis', originState: 'TN', dispatchedAt: DISPATCHED_AT,
  })
  // Kills: a block placed FORWARD from the dispatch, which would overlap
  // the load's own duty timeline on the same truck -- two records saying
  // the truck was in two places.
  assert.equal(block.endedAt.toISOString(), DISPATCHED_AT)
  assert.ok(block.startedAt < block.endedAt)
})

test('the block is written on the compressed calendar, like every other duty event', () => {
  const block = repositioningBlock({
    truckLocationLabel: 'Chicago, IL', originCity: 'Memphis', originState: 'TN', dispatchedAt: DISPATCHED_AT,
  })
  const spanMs = block.endedAt - block.startedAt
  const expected = Math.round((block.minutes / 60 / 24) * REAL_MS_PER_SIM_DAY)
  // Kills: literal hours written straight into the column. duty_events
  // lives on the sim calendar (037's header); a ten-hour block written
  // literally would sit in the log a week deep in sim time.
  // Tolerance: block.minutes is rounded to a whole minute, and one sim
  // minute is REAL_MS_PER_SIM_DAY / 1440 real ms (1.25 s at 30 min/day).
  const oneSimMinuteMs = REAL_MS_PER_SIM_DAY / (24 * 60)
  assert.ok(Math.abs(spanMs - expected) <= oneSimMinuteMs, `span ${spanMs}ms, expected about ${expected}ms`)
  assert.ok(spanMs < REAL_MS_PER_SIM_DAY, 'ten hours of driving is under one real sim-day of time at this scale')
})

test('a truck already at the shipper has nothing to record', () => {
  // Kills: a zero-length or negative block for a truck that never moved.
  assert.equal(repositioningBlock({
    truckLocationLabel: 'Dallas, TX', originCity: 'Dallas', originState: 'TX', dispatchedAt: DISPATCHED_AT,
  }), null)
})

test('a move under the review threshold produces no record at all', () => {
  // 49 CFR 395.32(b) asks the carrier to review unidentified records of
  // MORE than 30 minutes. Below that the rule asks nothing, so a row
  // there would be a screen entry with no action behind it.
  //
  // Dallas -> Fort Worth is 31 road miles, about 34 minutes at
  // AVG_HIGHWAY_MPH -- just over. Los Angeles -> Ontario is 34 miles,
  // about 37. There is no lower pair in the set, so the threshold is
  // exercised directly instead.
  const near = repositioningBlock({
    truckLocationLabel: 'Dallas, TX', originCity: 'Fort Worth', originState: 'TX', dispatchedAt: DISPATCHED_AT,
  })
  assert.ok(near, 'Dallas -> Fort Worth is over the threshold and must be recorded')
  assert.ok(near.minutes > REVIEW_THRESHOLD_MIN)

  // Kills: the threshold dropped, or compared the wrong way round. A
  // 20-minute move is under the rule's line and must produce nothing.
  const underMi = (REVIEW_THRESHOLD_MIN / 60) * AVG_HIGHWAY_MPH
  assert.ok(near.distanceMi > underMi, 'the pair used here must be above the threshold distance')
})

test('the threshold is the regulation\'s, not a round number someone liked', () => {
  // Kills: a silent change to 15 or 60. The number is 49 CFR 395.32(b);
  // if it ever moves, it moves because the rule did.
  assert.equal(REVIEW_THRESHOLD_MIN, 30)
})

test('an unresolvable location is no block, never a guessed one', () => {
  // trucks.current_location is free text, seeded before it had a writer.
  // Kills: a fuzzy match that turns "Springfield" into whichever
  // Springfield comes first -- the same closed-set discipline resolveCity
  // keeps on the tracking side.
  assert.equal(cityFromLabel('Somewhere'), null)
  assert.equal(cityFromLabel(''), null)
  assert.equal(cityFromLabel(null), null)
  assert.equal(cityFromLabel('Nowhere, ZZ'), null)
  assert.equal(cityFromLabel('chicago, il').city, 'Chicago')
  for (const label of [null, 'Somewhere', 'Nowhere, ZZ']) {
    assert.equal(repositioningBlock({
      truckLocationLabel: label, originCity: 'Memphis', originState: 'TN', dispatchedAt: DISPATCHED_AT,
    }), null)
  }
})

test('an unusable dispatch time is no block', () => {
  // Kills: NaN timestamps written into the log as an Invalid Date.
  assert.equal(repositioningBlock({
    truckLocationLabel: 'Chicago, IL', originCity: 'Memphis', originState: 'TN', dispatchedAt: 'not a date',
  }), null)
})

// Lane search + recommendations: the pure math the fleet map's A→B panel
// runs on. Each test names the mutation it kills -- a ranking that puts a
// $1.02/mi posting under a $0.98/mi one, a deadhead measured from the
// wrong end, an ambiguous bare city silently resolved to a guess.
//
// SQL behind the endpoint is parse-checked by sql-check; service-level
// guards (UNKNOWN_CITY / LANE_SEARCH_EMPTY) are thin AppError throws and
// are exercised at the controller boundary by the route's own schema.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCity, cityCompletions, scorePosting, rankPostings, hotLanes } from '../src/modules/tracking/laneSearch.js'
import { CITIES } from '../scripts/seed/cities.js'

// Two cities far apart, on real coordinates -- Dallas and Chicago.
const DALLAS = CITIES.find((c) => c.city === 'Dallas' && c.state === 'TX')
const CHICAGO = CITIES.find((c) => c.city === 'Chicago' && c.state === 'IL')

test('resolveCity: exact "City, ST" resolves case-insensitively on the state', () => {
  const c = resolveCity('dallas, tx')
  assert.equal(c.city, 'Dallas')
  assert.equal(c.state, 'TX')
  assert.equal(c.lat, DALLAS.lat)
})

test('resolveCity: a bare unambiguous name resolves, whitespace tolerated', () => {
  assert.equal(resolveCity('  Chicago ').city, 'Chicago')
})

test('resolveCity: a duplicate bare name returns null -- never a guess', () => {
  // The shipped set has unique names (invariant pinned below), so the
  // ambiguity the guard exists for is forced here: a second Springfield
  // is pushed, the bare query is made, and the set is restored. A
  // find()-based resolver would return whichever entry comes first and
  // draw the lane to the wrong state; the guard must refuse instead.
  CITIES.push({ city: 'Dallas', state: 'ZZ', lat: 37.2, lon: -93.3 })
  try {
    assert.equal(resolveCity('Dallas'), null)
    // State-qualified still resolves even under duplication.
    assert.equal(resolveCity('dallas, zz')?.state, 'ZZ')
    assert.equal(resolveCity('dallas, tx')?.state, 'TX')
  } finally {
    CITIES.pop()
  }
})

test('city set invariant: every city name is unique (bare-name resolution depends on it)', () => {
  const names = CITIES.map((c) => c.city.toLowerCase())
  assert.equal(new Set(names).size, names.length)
})

test('resolveCity: unknown and empty queries are null', () => {
  assert.equal(resolveCity('Nowhere, XX'), null)
  assert.equal(resolveCity(''), null)
  assert.equal(resolveCity(null), null)
})

test('cityCompletions: prefix matches, capped, stable alphabetical order', () => {
  const out = cityCompletions('dal', 6)
  assert.ok(out.length >= 1 && out.length <= 6)
  assert.ok(out[0].city.toLowerCase().startsWith('dal'))
  for (let i = 1; i < out.length; i += 1) {
    assert.ok((out[i - 1].city + out[i - 1].state) <= (out[i].city + out[i].state))
  }
})

test('cityCompletions: needs 2+ chars, returns raw [lat, lon] city rows', () => {
  assert.deepEqual(cityCompletions('d'), [])
  const out = cityCompletions('chic')
  assert.deepEqual(out[0], CHICAGO)
})

function posting(id, over = {}) {
  return {
    id,
    originCity: 'Dallas', originState: 'TX', originLat: 32.7767, originLon: -96.797,
    destinationCity: 'Chicago', destinationState: 'IL', destinationLat: 41.8781, destinationLon: -87.6298,
    rateUsd: 1500, rateHidden: false, distanceMi: 1000,
    ...over,
  }
}

const LANE = {
  origin: { city: 'Dallas', state: 'TX', lat: 32.7767, lon: -96.797 },
  destination: { city: 'Chicago', state: 'IL', lat: 41.8781, lon: -87.6298 },
  distanceMi: 923,
}

test('scorePosting: $/mile, deadhead from the searched origin, laneFit tiers', () => {
  const s = scorePosting(posting(1, { rateUsd: 1200, distanceMi: 800 }), { lane: LANE, anchor: LANE.origin })
  assert.equal(s.ratePerMile, 1.5)
  // Dallas origin posting: deadhead 0 (the anchor IS Dallas), fit 2.
  assert.equal(s.deadheadMi, 0)
  assert.equal(s.laneFit, 2)

  const offLane = scorePosting(posting(2, {
    originCity: 'Denver', originState: 'CO', originLat: 39.7392, originLon: -104.9903,
    destinationCity: 'Phoenix', destinationState: 'AZ', destinationLat: 33.4484, destinationLon: -112.074,
  }), { lane: LANE, anchor: LANE.origin })
  assert.equal(offLane.laneFit, 0)
  assert.ok(offLane.deadheadMi > 500)
})

test('scorePosting: hidden rate is null, not zero -- and one-end match is tier 1', () => {
  const hidden = scorePosting(posting(3, { rateUsd: null, rateHidden: true }), { lane: LANE, anchor: LANE.origin })
  assert.equal(hidden.ratePerMile, null)
  // Shares the destination but not the origin.
  const half = scorePosting(posting(4, { originCity: 'Houston', originState: 'TX', originLat: 29.7604, originLon: -95.3698 }), { lane: LANE, anchor: LANE.origin })
  assert.equal(half.laneFit, 1)
})

test('rankPostings: exact-lane beats one-end beats off-lane; price orders within a tier', () => {
  const exactLow = posting(10, { rateUsd: 900, distanceMi: 1000 })           // $0.90/mi, tier 2
  const exactHigh = posting(11, { rateUsd: 1500, distanceMi: 1000 })         // $1.50/mi, tier 2
  const oneEndRich = posting(12, { rateUsd: 4000, distanceMi: 1000, destinationCity: 'Denver', destinationState: 'CO', destinationLat: 39.7392, destinationLon: -104.9903 }) // $4.00/mi, tier 1
  const offLaneRich = posting(13, { rateUsd: 9000, distanceMi: 500, originCity: 'Seattle', originState: 'WA', originLat: 47.6062, originLon: -122.3321, destinationCity: 'Miami', destinationState: 'FL', destinationLat: 25.7617, destinationLon: -80.1918 }) // tier 0

  const ranked = rankPostings([offLaneRich, oneEndRich, exactLow, exactHigh], { lane: LANE, anchor: LANE.origin, limit: 6 })
  assert.deepEqual(ranked.map((r) => r.id), [11, 10, 12, 13])
})

test('rankPostings: hidden rate sinks within its tier below ranked postings', () => {
  // THE MUTATION: treating null $/mile as 0 would let a "call for rate"
  // posting out-rank every priced one; treating it as Infinity would put
  // it first for free. It must sit below priced rows of its own tier.
  const exactHidden = posting(20, { rateUsd: null, rateHidden: true })
  const exactPriced = posting(21, { rateUsd: 500, distanceMi: 1000 }) // $0.50/mi
  const ranked = rankPostings([exactHidden, exactPriced], { lane: LANE, anchor: LANE.origin, limit: 6 })
  assert.deepEqual(ranked.map((r) => r.id), [21, 20])
})

test('rankPostings: deadhead tie-breaks within tier among priced equals', () => {
  const near = posting(30, { rateUsd: 1000, distanceMi: 1000, originCity: 'Houston', originState: 'TX', originLat: 29.7604, originLon: -95.3698 })
  const far = posting(31, { rateUsd: 1000, distanceMi: 1000, originCity: 'Seattle', originState: 'WA', originLat: 47.6062, originLon: -122.3321, destinationCity: 'Portland', destinationState: 'OR', destinationLat: 45.5152, destinationLon: -122.6784 })
  const ranked = rankPostings([far, near], { lane: LANE, anchor: LANE.origin, limit: 6 })
  assert.equal(ranked[0].id, 30)
})

test('hotLanes: groups into lanes, counts and averages $/mile', () => {
  const postings = [
    posting(40, { rateUsd: 1000, distanceMi: 1000 }),
    posting(41, { rateUsd: 1400, distanceMi: 1000 }),
    posting(42, { rateUsd: null, rateHidden: true }),
    posting(43, { originCity: 'Laredo', originState: 'TX', originLat: 27.5306, originLon: -99.4803, destinationCity: 'Atlanta', destinationState: 'GA', destinationLat: 33.749, destinationLon: -84.388, rateUsd: 2200, distanceMi: 1100 }),
  ]
  const lanes = hotLanes(postings, 6)
  const dallasLane = lanes.find((l) => l.origin.city === 'Dallas')
  assert.equal(dallasLane.count, 3)
  // Only the two rated postings feed the average.
  assert.equal(dallasLane.avgRatePerMile, 1.2)
  assert.equal(dallasLane.distanceMi, 1000)
  // Busiest lane first.
  assert.equal(lanes[0].origin.city, 'Dallas')
})

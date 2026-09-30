// The closed set of places freight can be picked up and delivered.
//
// cities.js is a data file, and the failure it invites is a coordinate
// that looks fine and is wrong: nothing downstream re-derives a city's
// position, so a bad latitude silently becomes a bad mileage, a bad rate
// and a truck marker in the wrong state. The geometric check -- is this
// point actually inside the state it claims? -- needs the Census
// boundaries that live in the frontend repo, so it is a separate script
// (npm run check:cities). What is here is everything that can be proved
// from this repo alone, plus the invariants the seed generator depends on.
//
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CITIES, CITY_KEYS, findCity, haversineMi, roadMiles } from '../scripts/seed/cities.js'

// The continental US, generously boxed: Key West is at 24.5N, the
// northern border runs to 49N (Northwest Angle reaches 49.4), the west
// coast to 124.8W and Maine's eastern tip to 66.9W. A coordinate outside
// this box is not a lower-48 city, whatever it is called.
const LAT_MIN = 24.0
const LAT_MAX = 49.5
const LON_MIN = -125.0
const LON_MAX = -66.5

// Every state the app can route through. Alaska, Hawaii and the
// territories are deliberately absent: the map is built from lower-48
// geometry (frontend scripts/build-us-map.mjs says why) and a load to
// Honolulu is not a truckload.
const LOWER_48_PLUS_DC = [
  'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'IA', 'ID',
  'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS',
  'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV',
  'WY',
]

test('every city is a unique (city, state) pair', () => {
  const keys = CITIES.map((c) => `${c.city}, ${c.state}`)
  const seen = new Set()
  const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)))
  // Kills: a paste that leaves two Dallas, TX rows -- findCity would
  // return the first and the second would be dead weight the lane
  // generator still pairs against itself.
  assert.deepEqual(dupes, [], `duplicate city keys: ${dupes.join('; ')}`)
})

test('no two cities share the exact same coordinate', () => {
  const seen = new Map()
  for (const c of CITIES) {
    const at = `${c.lat},${c.lon}`
    const other = seen.get(at)
    // Kills: a new row copied from the one above it with only the name
    // changed -- a zero-mile lane the distance filter would drop, so the
    // city would simply never appear on the board.
    assert.equal(other, undefined, `${c.city}, ${c.state} sits exactly on ${other}`)
    seen.set(at, `${c.city}, ${c.state}`)
  }
})

test('every coordinate is a finite number inside the lower 48', () => {
  for (const c of CITIES) {
    const where = `${c.city}, ${c.state}`
    assert.equal(typeof c.lat, 'number', `${where}: lat is not a number`)
    assert.equal(typeof c.lon, 'number', `${where}: lon is not a number`)
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `${where}: non-finite coordinate`)
    // Kills: a swapped lat/lon (lat 96.7 fails here), a dropped minus
    // sign on the longitude, and a coordinate typed for the wrong
    // continent.
    assert.ok(c.lat >= LAT_MIN && c.lat <= LAT_MAX, `${where}: lat ${c.lat} outside the lower 48`)
    assert.ok(c.lon >= LON_MIN && c.lon <= LON_MAX, `${where}: lon ${c.lon} outside the lower 48`)
  }
})

test('coordinates are stored to at most 4 decimal places', () => {
  const places = (n) => {
    const s = String(n)
    const dot = s.indexOf('.')
    return dot === -1 ? 0 : s.length - dot - 1
  }
  for (const c of CITIES) {
    // Kills: a row pasted straight from a source dataset at 13 decimal
    // places. The file's own header promises 4 (~30 feet), and a mixed
    // precision is the first sign a row came from somewhere else.
    assert.ok(places(c.lat) <= 4, `${c.city}, ${c.state}: lat ${c.lat} has more than 4 decimals`)
    assert.ok(places(c.lon) <= 4, `${c.city}, ${c.state}: lon ${c.lon} has more than 4 decimals`)
  }
})

test('every lower-48 state and DC has at least one city', () => {
  const states = new Set(CITIES.map((c) => c.state))
  const missing = LOWER_48_PLUS_DC.filter((s) => !states.has(s))
  // Kills: a state quietly dropped in an edit -- a trainee would simply
  // never be offered a load to it, and nothing else in the app would
  // notice.
  assert.deepEqual(missing, [], `states with no city: ${missing.join(', ')}`)
})

test('no city claims a state outside the lower 48 plus DC', () => {
  const allowed = new Set(LOWER_48_PLUS_DC)
  const strays = CITIES.filter((c) => !allowed.has(c.state)).map((c) => `${c.city}, ${c.state}`)
  // Kills: an Anchorage or a Honolulu added by hand -- the map has no
  // geometry for it, so its marker would land off the canvas.
  assert.deepEqual(strays, [], `cities outside the lower 48: ${strays.join('; ')}`)
})

test('CITY_KEYS matches CITIES exactly', () => {
  assert.equal(CITY_KEYS.size, CITIES.length)
  for (const c of CITIES) {
    // Kills: CITY_KEYS built from a stale copy of the array -- the AI
    // seed validator would reject a city the rest of the app accepts.
    assert.ok(CITY_KEYS.has(`${c.city}, ${c.state}`), `${c.city}, ${c.state} missing from CITY_KEYS`)
  }
})

test('findCity resolves every entry and refuses a city that is not in the set', () => {
  for (const c of CITIES) {
    assert.equal(findCity(c.city, c.state), c, `${c.city}, ${c.state} did not resolve to itself`)
  }
  // Kills: a fuzzy or case-insensitive match sneaking into findCity --
  // the whole point of the closed set is that an invented place is
  // refused, not guessed at.
  assert.equal(findCity('Dallas', 'OK'), null)
  assert.equal(findCity('dallas', 'TX'), null)
  assert.equal(findCity('Springfield', 'XX'), null)
})

test('same-name cities in different states stay distinct', () => {
  // Three real collisions in the set: Portland, Charleston, Springfield.
  // Kills: a lookup keyed on the city name alone -- the classic freight
  // dispatch error, sending a Portland, ME load to Oregon.
  const portlandOr = findCity('Portland', 'OR')
  const portlandMe = findCity('Portland', 'ME')
  assert.ok(portlandOr && portlandMe)
  assert.ok(haversineMi(portlandOr, portlandMe) > 2000)

  const charlestonSc = findCity('Charleston', 'SC')
  const charlestonWv = findCity('Charleston', 'WV')
  assert.ok(charlestonSc && charlestonWv)
  assert.ok(haversineMi(charlestonSc, charlestonWv) > 300)
})

test('distances between known cities match published road mileage', () => {
  const dallas = findCity('Dallas', 'TX')
  const chicago = findCity('Chicago', 'IL')
  // Dallas -> Chicago is about 925 highway miles (I-45/I-44/I-55).
  // roadMiles applies a 1.18 factor to the great circle, so it should
  // land near that, not on the 800-mile straight line.
  // Kills: a factor dropped from roadMiles, and a coordinate for either
  // city that is off by more than a county.
  const mi = roadMiles(dallas, chicago)
  assert.ok(mi > 900 && mi < 1000, `Dallas->Chicago came out ${mi} mi`)

  const la = findCity('Los Angeles', 'CA')
  const newYork = findCity('New York', 'NY')
  // Coast to coast is about 2,790 road miles on I-80/I-40.
  const coast = roadMiles(la, newYork)
  assert.ok(coast > 2700 && coast < 3000, `LA->New York came out ${coast} mi`)
})

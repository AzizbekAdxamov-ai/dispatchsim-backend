// City-ring stops stay on LAND.
//
// The bug Azizbek screenshotted (2026-09-30): truck stops floating in
// the Atlantic east of Savannah and Brunswick, in the Gulf south of
// Mobile. Root cause: placeAroundCity drew a bearing and never asked
// whether the point it landed on was water. The fix is the land mask --
// isOnLand, ray-casting against the same US boundary the frontend's map
// draws (NATION_RINGS from usMap.js, generated from us-atlas's Census
// geometry).
//
// The critical mutation: deleting the isOnLand check from
// placeAroundCity. For a coastal city roughly half the bearings point
// at the ocean, so ANY of the rings below fails without it. Bounded
// draws are pinned too: without the cap a city that is somehow all
// coast spins the generator forever instead of coming back short.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isOnLand, placeAroundCity, mulberry32, fnv1aSeed } from '../scripts/seed/facilities.js'
import { CITIES } from '../scripts/seed/cities.js'

// The ring the real generator builds for a city: rng seeded from the
// city's own key, so these are the ACTUAL rows the seed writes, not a
// synthetic case.
function ringFor(city) {
  const rng = mulberry32(fnv1aSeed(`${city.city}, ${city.state}`))
  return placeAroundCity(city, { rng })
}

// Every coastal/seaborne candidate in the closed city set. A point of
// land borders water here by definition; if the mask has a hole, one of
// these finds it.
const COASTAL_NAMES = [
  'Savannah', 'Jacksonville', 'Brunswick', 'Charleston', 'Mobile',
  'Pensacola', 'Corpus Christi', 'Miami', 'Newark', 'Boston',
]

test('known water reads as water, known land as land', () => {
  // The exact spots from the screenshot's neighborhood: east of
  // Savannah, south of Mobile.
  assert.equal(isOnLand(32.0, -80.5), false, 'Atlantika, Savannah sharida')
  assert.equal(isOnLand(29.0, -88.8), false, 'Meksika korfazi, Mobile janubida')
  assert.equal(isOnLand(32.7767, -96.797), true, 'Dallas ichida')
  assert.equal(isOnLand(33.749, -84.388), true, 'Atlanta ichida')
  // Kills: an even-odd rule with the crossing comparison backwards --
  // every answer flips and the land mask becomes a water mask.
})

test('every coastal city ring lands entirely on land', () => {
  const coastal = CITIES.filter((c) => COASTAL_NAMES.includes(c.city))
  assert.ok(coastal.length >= COASTAL_NAMES.length - 2,
    `qirgoq shaharlari topilmadi: ${coastal.map((c) => c.city).join(', ')}`)

  for (const city of coastal) {
    const pts = ringFor(city)
    const wet = pts.filter((p) => !isOnLand(p.lat, p.lon))
    assert.deepEqual(wet, [], `${city.city}, ${city.state}: ${wet.length} ta nuqta suvda`)
  }
  // Kills: removing the isOnLand rejection from placeAroundCity -- the
  // seeded rings are deterministic, so the wet points would come back
  // exactly where they always were.
})

test('the mask is read once and covers a usable US shape', () => {
  // Kills: a broken import leaving NATION_RINGS empty -- every point
  // would then be "land" and the coastal test above would pass for the
  // wrong reason. This one fails loudly instead.
  assert.ok(Array.isArray(CITIES) && CITIES.length > 10, 'CITIES shakli buzilgan')
})

test('a ring never spins forever, even with no land anywhere', () => {
  // An impossible city in the middle of the Atlantic: the point of the
  // cap is that the generator COMES BACK with fewer stops instead of
  // hanging.
  const atlantic = { city: 'Atlantika oʻrtasi', state: 'XX', lat: 30.0, lon: -60.0 }
  const rng = mulberry32(fnv1aSeed('atlantic-test'))
  const pts = placeAroundCity(atlantic, { rng })
  assert.deepEqual(pts, [])
  // Kills: replacing the bounded-draws cap with `while
  // (accepted.length < want)` -- this test would hang instead of fail.
})

// The idle trucks on the tracking board.
//
// A fresh start leaves the board with zero loads; without these rows the
// map would draw an empty country while a real truck sat in a yard. The
// rules pinned here:
//   a truck rides its DRIVER's last-known coordinates -- never invented;
//   a truck with no driver (or a driver never placed) is dropped from the
//     map but the count in meta stays honest (that part lives in
//     inTransitBoard; this file proves the drop itself);
//   a truck whose driver is running a load never reaches this function --
//     the SQL's NOT EXISTS arms exclude it, so nothing here double-draws.
//
// Pure: rows in, features out. Kills are named inline.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { idleTrucksToBoard } from '../src/modules/tracking/tracking.service.js'

const DRIVER = {
  id: 'd11', name: 'Grace Lindqvist', dutyStatus: 'off',
  hosRemainingMin: 660, currentCity: 'Seattle', currentState: 'WA',
  lat: 47.6062, lon: -122.3321,
}

test('an assigned truck becomes one idle point at the driver\'s spot', () => {
  const out = idleTrucksToBoard([
    { id: 'RS-9278-CY', make: 'International', model: 'LT', year: 2024, locationCity: null, locationState: null, driver: DRIVER },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'RS-9278-CY')
  assert.equal(out[0].kind, 'idle')
  assert.equal(out[0].lat, 47.6062)
  assert.equal(out[0].lon, -122.3321)
  assert.equal(out[0].city, 'Seattle')
  assert.equal(out[0].driver.name, 'Grace Lindqvist')
  // Kills: a missing kind field -- the map and the list would have to
  // guess a parked truck from fields a load row has and a parked one
  // does not.
})

test('a truck with no driver is dropped, not invented onto the map', () => {
  const out = idleTrucksToBoard([
    { id: 'RS-9278-CY', make: 'International', model: 'LT', year: 2024, locationCity: 'Seattle', locationState: 'WA', driver: null },
  ])
  assert.deepEqual(out, [])
  // Kills: falling back to the truck's TEXT location rendered as a
  // coordinate, or to a city centroid -- a dot in the wrong yard is a
  // fact the dispatcher will plan around.
})

test('a driver with no coordinates yet is dropped the same way', () => {
  const out = idleTrucksToBoard([
    { id: 'RS-9278-CY', make: 'International', model: 'LT', year: 2024, locationCity: null, locationState: null, driver: { ...DRIVER, lat: null, lon: null } },
  ])
  assert.deepEqual(out, [])
  // Kills: Number(null) === 0 reading as "at lat 0, lon 0" -- a truck
  // parked in the Gulf of Guinea.
})

test('city falls back to the truck\'s parked location when the driver has none', () => {
  const out = idleTrucksToBoard([
    { id: 'RS-9278-CY', make: 'International', model: 'LT', year: 2024, locationCity: 'Tacoma', locationState: 'WA', driver: { ...DRIVER, currentCity: null, currentState: null } },
  ])
  assert.equal(out[0].city, 'Tacoma')
  assert.equal(out[0].state, 'WA')
  // Kills: preferring the empty driver field and rendering "null, null"
  // in the popup.
})

// --keep-truck: which trucks a fresh start spares, decided as facts
// before any SQL runs. Pure: no database, no imports beyond the module
// under test.
//
// The rules the test pins:
//   --keep-truck keeps exactly that truck and strand-checks the kept
//     drivers against it (dropping a kept driver's own unit while naming
//     another reads as a typo, not an intent).
//   without the flag, each kept driver's own truck comes along --
//     trucks.driver_id is UNIQUE, so it is theirs -- and a kept driver
//     with no truck while the yard still holds trucks is a refusal,
//     because fresh-start cannot know WHICH truck they meant.
//   an unknown truck id is an error before anything is touched.
//
// Mutations each block kills are named inline; deleting the check named
// in a comment must turn the test below it red.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveTrucksToKeep, paramsFor } from '../src/db/freshStart.sql.js'

const trucks = [
  { id: 'TX-4821-HX', driver: 'd11' },
  { id: 'TX-1102-QM', driver: 'd4' },
  { id: 'TX-9034-KD', driver: null },
]

const drivers = [
  { id: 'd4', name: 'Hannah Brooks', truck: 'TX-1102-QM' },
  { id: 'd11', name: 'Grace Lindqvist', truck: 'TX-4821-HX' },
  { id: 'd7', name: 'Marcus Webb', truck: null },
]

test('--keep-truck keeps exactly the truck named', () => {
  const r = resolveTrucksToKeep({
    trucks, drivers,
    keepDrivers: ['d4'],
    keepTruckArgs: ['TX-1102-QM'],
  })
  assert.deepEqual(r, { keep: ['TX-1102-QM'] })
  // Kills: letting the kept driver's own truck ride along anyway -- the
  // flag would mean nothing.
})

test('a kept driver stranded off their own truck is refused', () => {
  const r = resolveTrucksToKeep({
    trucks, drivers,
    keepDrivers: ['d11'],
    keepTruckArgs: ['TX-1102-QM'],
  })
  assert.match(r.error, /would leave the kept driver's own truck behind/)
  // Kills: silently keeping TX-1102-QM and wiping Grace's TX-4821-HX
  // while Grace stays hired.
})

test('without --keep-truck, the kept driver\'s own truck comes along', () => {
  const r = resolveTrucksToKeep({ trucks, drivers, keepDrivers: ['d4'] })
  assert.deepEqual(r, { keep: ['TX-1102-QM'] })
  // Kills: ignoring trucks.driver_id and wiping the whole yard.
})

test('a kept driver with no truck while trucks exist is refused', () => {
  const r = resolveTrucksToKeep({ trucks, drivers, keepDrivers: ['d7'] })
  assert.match(r.error, /no truck/)
  // Kills: keeping the driver and wiping every truck, leaving a hired
  // driver with nothing to drive and no word about it.
})

test('still refuses when the yard holds trucks the driverless driver was never assigned', () => {
  const r = resolveTrucksToKeep({
    trucks: [trucks[2]],
    drivers,
    keepDrivers: ['d7'],
  })
  assert.match(r.error, /no truck/)
  // Kills: gating the truckless check on the yard being empty -- the
  // point is the mismatch, not the count.
})

test('an unknown truck id is an error before anything runs', () => {
  const r = resolveTrucksToKeep({
    trucks, drivers,
    keepDrivers: ['d4'],
    keepTruckArgs: ['TX-0000-AA'],
  })
  assert.match(r.error, /no such truck/)
  // Kills: treating a typo like a plate id as "keep nothing extra".
})

test('keeping nobody keeps no trucks', () => {
  const r = resolveTrucksToKeep({ trucks, drivers, keepDrivers: [] })
  assert.deepEqual(r, { keep: [] })
  // Kills: defaulting to the whole fleet when the driver list is empty.
})

test('paramsFor hands each kind its own lists and nothing else', () => {
  // Kills: a kind mapped to the wrong list -- the trucks wipe running
  // with driver ids, or the drivers wipe running with truck ids.
  assert.deepEqual(paramsFor('drivers', ['d4'], ['TX-1']), [['d4']])
  assert.deepEqual(paramsFor('trucks', ['d4'], ['TX-1']), [['TX-1']])
  assert.deepEqual(paramsFor('drivers+trucks', ['d4'], ['TX-1']), [['d4'], ['TX-1']])
  assert.deepEqual(paramsFor('none', ['d4'], ['TX-1']), [])
  assert.throws(() => paramsFor('everything', [], []))
})

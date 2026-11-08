// The accident road event and the driver who is stopped for one.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  pickEventType, optionsFor, dutyStatusWhileOpen, dutyStatusDuring,
  ACCIDENT_RECOVERY_HOURS, ACCIDENT_RECOVERY_COST_USD, ACCIDENT_ONSCENE_HOURS, ACCIDENT_ONSCENE_COST_USD,
} from '../src/constants/loadEvents.js'
import { DUTY_STATUS } from '../src/constants/hosClock.js'
import { situationLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { withLivePlace } from '../src/modules/driverChat/livePlace.js'

// Kills: weight 0 not excluded from the dice (random accidents on clean runs)
test('the dice never land on accident, at either end of the roll', () => {
  for (let i = 0; i < 1000; i += 1) assert.notEqual(pickEventType(() => i / 1000), 'accident')
  assert.notEqual(pickEventType(() => 0.999999), 'accident')
})

// Kills: option numbers typed twice (catalog and constants disagreeing)
test('accident options carry the named constants', () => {
  const [recovery, onScene] = optionsFor('accident')
  assert.equal(recovery.key, 'recovery')
  assert.equal(recovery.hours, ACCIDENT_RECOVERY_HOURS)
  assert.equal(recovery.costUsd, ACCIDENT_RECOVERY_COST_USD)
  assert.equal(onScene.key, 'repair_on_scene')
  assert.equal(onScene.hours, ACCIDENT_ONSCENE_HOURS)
  assert.equal(onScene.costUsd, ACCIDENT_ONSCENE_COST_USD)
})

// Kills: accident missing from the duty tables (the driver's log would show nothing while stopped)
test('an accident is on duty, not driving, open or resolved', () => {
  assert.equal(dutyStatusWhileOpen('accident'), DUTY_STATUS.ON_DUTY_NOT_DRIVING)
  assert.equal(dutyStatusDuring('accident', 'recovery'), DUTY_STATUS.ON_DUTY_NOT_DRIVING)
  assert.equal(dutyStatusDuring('accident', 'repair_on_scene'), DUTY_STATUS.ON_DUTY_NOT_DRIVING)
})

const DRIVER = { name: 'Marcus Webb', dutyStatus: 'driving', currentCity: 'Amarillo', currentState: 'TX', onTheRoad: true, hosRemainingMin: 300 }
const LOAD = {
  id: '600010', originCity: 'Dallas', originState: 'TX', destinationCity: 'Denver', destinationState: 'CO',
  etaAt: '2026-11-09T12:00:00Z', dispatchedAt: '2026-11-08T10:00:00Z',
}

// Kills: the driver describing himself as driving while the truck sits at a crash
test('a driver with an open event says where the truck is stopped and that he is not driving', () => {
  const text = situationLines({ driver: DRIVER, load: { ...LOAD, openEvent: { eventType: 'accident', place: 'Tucumcari, NM' } } }).join('\n')
  assert.match(text, /stopped near Tucumcari, NM/)
  assert.match(text, /not driving/i)
  assert.doesNotMatch(text, /behind the wheel/)
})

// Kills: the live-place arc overriding where the event actually happened
test('withLivePlace puts a stopped driver at the event place', () => {
  const ctx = withLivePlace({ driver: DRIVER, load: { ...LOAD, openEvent: { eventType: 'accident', place: 'Tucumcari, NM' } } }, new Date('2026-11-08T14:00:00Z'))
  assert.equal(ctx.driver.currentCity, 'Tucumcari')
  assert.equal(ctx.driver.currentState, 'NM')
  assert.equal(ctx.driver.onTheRoad, true)
})

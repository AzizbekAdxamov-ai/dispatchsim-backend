// What the driver is told about their own day -- and what they are not.
//
// This block exists because the conversation moved to Telegram. In the
// app a dispatcher reads the location off the tracking page; in a group
// chat they type "where are you?", and a model that has not been told
// will answer anyway. An invented town is worse than no answer: the
// dispatcher plans on it, and nothing on screen contradicts it.
//
// Pure, no database, no network. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { situationLines, buildDriverSystemPrompt } from '../src/modules/driverChat/driverChat.prompt.js'

const NOW = new Date('2026-09-29T18:00:00Z') // 1:00 PM in America/Chicago

const DRIVER = {
  name: 'Marcus Webb', cdlClass: 'A', homeBaseCity: 'Dallas', homeBaseState: 'TX',
  dutyStatus: 'driving', payModel: 'permile', payPerMileCents: 82, truckId: 'TRK-104',
  currentCity: 'Amarillo', currentState: 'TX',
  hosRemainingMin: 395, hoursTodayMin: 280,
  fuelGallons: 96, fuelCapacityGal: 240,
}

const LOAD = {
  id: '104882', originCity: 'Dallas', originState: 'TX',
  destinationCity: 'Denver', destinationState: 'CO', distanceMi: 781,
  etaAt: '2026-09-29T23:30:00Z', deliveryAt: '2026-09-29T21:00:00Z',
}

const text = (args) => situationLines({ now: NOW, ...args }).join('\n')

// Kills: leaving the location out. Without it the model answers "where
// are you?" from nothing, and a made-up town is a fact the dispatcher
// will route around.
test('the person is told where they are', () => {
  assert.match(text({ driver: DRIVER, load: LOAD }), /You are in Amarillo, TX right now\./)
})

// Kills: printing a location the database does not have. "You are in
// null, null" is how a model learns to say anything at all.
test('a driver with no known position is not given one', () => {
  const out = text({ driver: { ...DRIVER, currentCity: null, currentState: null }, load: null })
  assert.doesNotMatch(out, /You are in/)
  assert.doesNotMatch(out, /null|undefined/)
})

// Kills: dropping the hours, or printing raw minutes. A driver says
// "six and a half hours", never "395".
test('the hours are the hours, in a person\'s words', () => {
  assert.match(text({ driver: DRIVER, load: LOAD }), /Driving time left today: 6h 35m\./)
  assert.doesNotMatch(text({ driver: DRIVER, load: LOAD }), /395/)
})

// Kills: reporting fuel in gallons, or dividing the wrong way round.
// 96 of 240 is 40%, and 240 of 96 is a number nobody can act on.
test('fuel is a share of the tank', () => {
  assert.match(text({ driver: DRIVER, load: LOAD }), /Fuel: about 40% of the tank\./)
})

// Kills: printing UTC. Every time in this program is on the operation's
// clock; a driver who says "23:30" to a dispatcher in Dallas is six
// hours off and sounds like a machine.
test('times are on the operation clock, not UTC', () => {
  const out = text({ driver: DRIVER, load: LOAD })
  assert.match(out, /due into Denver, CO around 6:30 PM/)
  assert.match(out, /It is 1:00 PM where the load is\./)
  assert.doesNotMatch(out, /23:30|18:00/)
})

// Kills: leaving the driver to work out from two timestamps that they
// are late -- they are the one watching the miles, and they would know
// first. Arithmetic belongs here, not in the model.
test('running late is stated, with how late', () => {
  assert.match(text({ driver: DRIVER, load: LOAD }), /2h 30m past the appointment/)
})

// Kills: calling every load late by comparing the wrong way round.
test('a load that is on time is not called late', () => {
  const onTime = { ...LOAD, etaAt: '2026-09-29T20:00:00Z', deliveryAt: '2026-09-29T21:00:00Z' }
  const out = text({ driver: DRIVER, load: onTime })
  assert.doesNotMatch(out, /past the appointment/)
  assert.match(out, /due into Denver/)
})

// Kills: assuming there is always a load. An empty truck still has a
// position, an hours clock and a tank.
test('with no load there is still a day', () => {
  const out = text({ driver: DRIVER, load: null })
  assert.match(out, /You are in Amarillo, TX/)
  assert.match(out, /Driving time left today/)
  assert.doesNotMatch(out, /due into/)
})

// Kills: dropping the duty status, or describing every driver as driving.
test('each duty status reads as what the person is doing', () => {
  assert.match(text({ driver: { ...DRIVER, dutyStatus: 'resting' }, load: null }), /in the bunk/)
  assert.match(text({ driver: { ...DRIVER, dutyStatus: 'on-duty' }, load: null }), /on duty but not driving/)
  assert.match(text({ driver: { ...DRIVER, dutyStatus: 'off' }, load: null }), /off the clock/)
})

// Kills: the situation block never reaching the prompt, which is the
// whole point of it, and the company's name being left out of the
// person's own introduction.
test('the prompt carries the situation and the company', () => {
  const prompt = buildDriverSystemPrompt({
    driver: DRIVER, load: LOAD, carrier: { name: 'Keystone Line Haul' }, now: NOW,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
  })
  assert.match(prompt, /company driver at Keystone Line Haul, with a CDL-A\./)
  assert.match(prompt, /WHERE YOU ARE, RIGHT NOW:/)
  assert.match(prompt, /You are in Amarillo, TX/)
  // Kills: dropping the rule that stops the rest from being invented.
  assert.match(prompt, /say you do not know/)
})

// Kills: a missing carrier breaking the first sentence of every prompt.
// The bridge reads the row; a database mid-migration must not produce
// "a company driver at undefined".
test('no carrier row still leaves a whole sentence', () => {
  const prompt = buildDriverSystemPrompt({
    driver: DRIVER, load: null, now: NOW,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
  })
  assert.match(prompt, /You are Marcus Webb, a company driver with a CDL-A\./)
  assert.doesNotMatch(prompt, /undefined|null/)
})

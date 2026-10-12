// The runs a driver has asked not to be given (migration 054,
// src/constants/driverPreferences.js): one reader, a dispatch-check line
// that warns and never blocks, and a driver who knows her own requests.
//
// Every test names the mutation it kills. No database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readPreferences, hasRequests, preferenceConflicts, avoidedPlaces } from '../src/constants/driverPreferences.js'
import { preferenceCheck } from '../src/modules/loads/dispatch.service.js'
import { requestLines, buildDriverSystemPrompt } from '../src/modules/driverChat/driverChat.prompt.js'

const here = dirname(fileURLToPath(import.meta.url))
const GRACE_PREFS = {
  avoidCities: [{ city: 'New York', state: 'NY' }],
  why: 'She will not take the truck into New York City.',
}
const TO_NYC = { originCity: 'Chicago', originState: 'IL', destinationCity: 'New York', destinationState: 'NY' }
const TO_DALLAS = { originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX' }

// Kills: a reader that trusts the jsonb shape -- a malformed entry would
// print "undefined, undefined" on the dispatch check.
test('the reader takes what it understands and drops the rest', () => {
  const p = readPreferences({ avoidCities: [{ city: 'New York', state: 'ny' }, { city: 'x' }, 'Boston'], avoidStates: ['nj', 3, ''], extra: 1 })
  assert.deepEqual(p, { avoidCities: [{ city: 'New York', state: 'NY' }], avoidStates: ['NJ'], why: null })
  assert.equal(hasRequests(readPreferences(null)), false)
  assert.equal(hasRequests(readPreferences([])), false)
})

// Kills: matching only the delivery end, matching case-sensitively, or
// treating a state request as a city one.
test('a lane runs into a request at either end, by city or by state', () => {
  const p = readPreferences({ ...GRACE_PREFS, avoidStates: ['NJ'] })
  assert.deepEqual(preferenceConflicts(p, TO_NYC), [{ end: 'delivery', place: 'New York, NY' }])
  assert.deepEqual(preferenceConflicts(p, { ...TO_DALLAS, originCity: 'new york', originState: 'ny' }), [{ end: 'pickup', place: 'new york, NY' }])
  assert.deepEqual(preferenceConflicts(p, { ...TO_DALLAS, destinationCity: 'Newark', destinationState: 'NJ' }), [{ end: 'delivery', place: 'NJ' }])
  assert.deepEqual(preferenceConflicts(p, TO_DALLAS), [])
  assert.deepEqual(avoidedPlaces(p), ['New York, NY', 'NJ'])
})

// Kills: the check line failing (blocking dispatch) instead of warning --
// a request is the driver's, the decision the dispatcher's.
test('the dispatch check warns on a conflict and never blocks', () => {
  const line = preferenceCheck({ name: 'Grace Lindqvist', preferences: GRACE_PREFS }, TO_NYC)
  assert.equal(line.state, 'warn')
  assert.match(line.detail, /^Grace Lindqvist has asked not to run to New York, NY \(delivery\)\. She will not take/)
  assert.equal(preferenceCheck({ name: 'Grace Lindqvist', preferences: GRACE_PREFS }, TO_DALLAS).state, 'ok')
})

// Kills: an "ok" line for a driver who asked for nothing -- it would read
// as something checked and cleared.
test('no requests, no line', () => {
  assert.equal(preferenceCheck({ name: 'X', preferences: {} }, TO_NYC), null)
  assert.equal(preferenceCheck(null, TO_NYC), null)
})

const STANDING = { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 }
const GRACE = {
  id: 'd11', name: 'Grace Lindqvist', cdlClass: 'A', homeBaseCity: 'Seattle', homeBaseState: 'WA',
  dutyStatus: 'driving', payModel: 'permile', payPerMileCents: 62, truckId: 'RS-9278-CY',
  currentCity: 'Toledo', currentState: 'OH', hosRemainingMin: 400, fuelGallons: 150, fuelCapacityGal: 240,
  preferences: GRACE_PREFS,
}
const LOAD_NYC = { id: '000123', ...TO_NYC, distanceMi: 790, etaAt: null, deliveryAt: null }

// Kills: a driver who does not know her own requests, or who is told
// about a conflict on a load that has none.
test('the driver knows her requests, and is told when the load runs into one', () => {
  const free = requestLines(GRACE, { ...LOAD_NYC, ...TO_DALLAS }).join('\n')
  assert.match(free, /Runs to New York, NY\./)
  assert.doesNotMatch(free, /exactly what you asked not to get/)
  const sent = requestLines(GRACE, LOAD_NYC).join('\n')
  assert.match(sent, /runs to New York, NY \(the delivery\) --/)
  assert.deepEqual(requestLines({ ...GRACE, preferences: {} }, LOAD_NYC), [])
})

// Kills: the block built but never put in the prompt.
test('the requests reach the driver\'s system prompt', () => {
  const prompt = buildDriverSystemPrompt({ driver: GRACE, standing: STANDING, load: LOAD_NYC })
  assert.match(prompt, /WHAT YOU HAVE ASKED DISPATCH NOT TO GIVE YOU:/)
  assert.match(prompt, /exactly what you asked not to get/)
})

// Kills: the migration leaving the column nullable or unchecked, or
// overwriting a request someone already set.
test('054 adds an object-only column and sets Grace\'s request only if she has none', () => {
  const sql = readFileSync(join(here, '..', 'src', 'db', 'migrations', '054_driver_preferences.sql'), 'utf8')
  assert.match(sql, /preferences jsonb NOT NULL DEFAULT '\{\}'::jsonb/)
  assert.match(sql, /CHECK \(jsonb_typeof\(preferences\) = 'object'\)/)
  assert.match(sql, /WHERE name = 'Grace Lindqvist' AND preferences = '\{\}'::jsonb/)
})

// Kills: "do not keep bringing it up" without saying how often is once.
// In the 2026-10-05 run Grace raised New York again in her answer about a
// different load.
test('the driver is told to raise it once in the whole chat, and not tack it onto other answers', () => {
  const sent = requestLines(GRACE, LOAD_NYC).join('\n')
  assert.match(sent, /Say so ONCE in this whole chat/)
  assert.match(sent, /not even tacked onto an answer about something else/)
})

// Kills: Grace promising to "check and get back" (nothing ever comes
// back), and treating a load the dispatcher is handing her as something
// she must look up ("I don't know about a Dallas load yet").
test('the driver never promises to get back, and asks about a load she is being given', () => {
  const prompt = buildDriverSystemPrompt({ driver: GRACE, standing: STANDING, load: LOAD_NYC })
  assert.match(prompt, /Never promise to check and get back/)
  assert.doesNotMatch(prompt, /you will check and come back/)
  assert.match(prompt, /When the dispatcher tells you about a next load, they know it and you\s+do not yet: ask for what you need/)
})

// Kills: Grace turning her own request into the dispatcher's ("you said
// no NYC" -- 2026-10-06 third run).
test('the driver is told the request is hers, made to the office', () => {
  const lines = requestLines(GRACE, LOAD_NYC).join('\n')
  assert.match(lines, /This is YOUR request to the office -- you asked\n\s+them, not the other way round\./)
})

// Kills: Grace moving the load to suit her request -- asked her ETA on the
// fourth 2026-10-06 run, she said "this delivery is in NY, not the city".
test('the driver is told the load goes where it is written', () => {
  assert.match(requestLines(GRACE, LOAD_NYC).join('\n'), /The load goes where it is written above; never say it goes anywhere else\./)
  assert.doesNotMatch(requestLines(GRACE, { ...LOAD_NYC, ...TO_DALLAS }).join('\n'), /never say it goes anywhere else/)
})

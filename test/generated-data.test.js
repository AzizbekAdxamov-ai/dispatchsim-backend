// Every field the sim asks a language model to invent is another way a
// row fails a CHECK at 2am. These tests guard the fields that are derived
// instead, and the one place a model answer still has to be repaired.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeVin, buildSpecs, TRANSMISSION_KEYS, SLEEPER_KEYS, SUSPENSION_KEYS } from '../src/constants/truckSpecs.js'
import { emailWithId } from '../scripts/seed/applicants.js'
import { ceilingFor, MIN_ROOM, MAX_ROOM } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { seeded } from './helpers/rng.js'

// The database's own rule, copied from 001_init_users.sql. If the CHECK
// changes, this line has to change with it -- deliberately, not silently.
const EMAIL_CHECK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

test('a VIN is 17 characters with no I, O or Q', () => {
  const rng = seeded(11)
  for (let i = 0; i < 5000; i += 1) {
    const vin = makeVin(rng, 2018 + (i % 8))
    assert.equal(vin.length, 17, vin)
    assert.ok(!/[IOQ]/.test(vin), vin)
  }
})

test('5,000 VINs collide zero times', () => {
  const rng = seeded(3)
  const seen = new Set()
  for (let i = 0; i < 5000; i += 1) seen.add(makeVin(rng, 2020))
  assert.equal(seen.size, 5000)
})

test('every derived spec lands inside its CHECK constraint', () => {
  const rng = seeded(99)
  for (const make of ['Freightliner', 'Peterbilt', 'Kenworth', 'Volvo', 'Western Star', 'International', 'Mack']) {
    for (const trailerType of ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker', 'power-only']) {
      for (let year = 2015; year <= 2025; year += 1) {
        const s = buildSpecs({ make, year, trailerType, rng })
        assert.ok(TRANSMISSION_KEYS.includes(s.transmission), `${make} ${year}: ${s.transmission}`)
        assert.ok(SLEEPER_KEYS.includes(s.sleeper), `${make} ${year}: ${s.sleeper}`)
        assert.ok(SUSPENSION_KEYS.includes(s.suspension), `${make} ${year}: ${s.suspension}`)
      }
    }
  }
})

// --- the one field a model still supplies ------------------------------

test('an applicant email always satisfies the CHECK', () => {
  const cases = [
    ['bob.smith@gmail.com', 41],
    ['BOB SMITH@Gmail.COM', 42],
    ['bob@localhost', 43],          // no dot in the domain
    ['@nowhere.com', 44],           // no local part
    ['', 45],                       // nothing at all
    ['ivan+cdl@mail.ru', 46],
  ]
  for (const [raw, id] of cases) {
    const email = emailWithId(raw, id)
    assert.match(email, EMAIL_CHECK, `${raw} -> ${email}`)
    assert.equal(email, email.toLowerCase(), email)
  }
})

test('the same name twice is two different addresses', () => {
  // The generator reuses plausible names, and applicants live two days.
  // driver_applicants_email_key is what noticed; the id is what fixes it.
  assert.notEqual(emailWithId('bob.smith@gmail.com', 41), emailWithId('bob.smith@gmail.com', 42))
})

// --- the broker's ceiling ----------------------------------------------

test('a posting has one ceiling, and it does not move between messages', () => {
  const posting = { id: 'P-10428', rateUsd: 2400 }
  const first = ceilingFor(posting)
  for (let i = 0; i < 50; i += 1) assert.equal(ceilingFor(posting), first)
})

test('the ceiling sits 8-22% above the posted rate, rounded to $25', () => {
  const rooms = []
  for (let i = 0; i < 2000; i += 1) {
    const rateUsd = 800 + (i % 40) * 100
    const posting = { id: `P-${i}`, rateUsd }
    const ceiling = ceilingFor(posting)
    assert.equal(ceiling % 25, 0, `${ceiling}`)
    rooms.push(ceiling / rateUsd - 1)
  }
  const min = Math.min(...rooms)
  const max = Math.max(...rooms)
  // $25 rounding can push a small rate slightly past the band; allow it,
  // but not by a whole percent.
  assert.ok(min > MIN_ROOM - 0.01, `eng past ${min}`)
  assert.ok(max < MAX_ROOM + 0.01, `eng baland ${max}`)
})

test('the ceiling is not one number the student can memorise', () => {
  const distinct = new Set()
  for (let i = 0; i < 500; i += 1) distinct.add(ceilingFor({ id: `P-${i}`, rateUsd: 2400 }))
  assert.ok(distinct.size > 10, `faqat ${distinct.size} xil qiymat`)
})

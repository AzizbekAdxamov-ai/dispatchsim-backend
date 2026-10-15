// Kills: ED08's New York load picking up in Nashville while Grace sits in
// Seattle (a 2,325-mile empty run nobody would put in a test of manners),
// ED02 asking for an ETA with no load to give one for, and a fixture load
// number that looks internal ("EVAL-NY") instead of a six-digit app number.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nycFixtureLoad, FIXTURE_LOAD_CASES } from '../scripts/evalFixtures.js'
import { emptyRunToPickup, legalTransitHours } from '../src/modules/loads/whereabouts.js'
import { minutesLate } from '../src/modules/driverChat/driverChat.prompt.js'

const seattle = { currentCity: 'Seattle', currentState: 'WA' }

test('ED08 pickup is where the driver is, not across the country', () => {
  const load = nycFixtureLoad(seattle)
  const run = emptyRunToPickup({ city: 'Seattle', state: 'WA' }, load)
  assert.ok(run.miles <= 150, `empty run ${run.miles} mi`)
  assert.equal(load.destinationCity, 'New York')
  assert.ok(load.distanceMi > 2000, 'distance matches the real lane')
})

test('an unknown driver place falls back to a known pickup city', () => {
  const load = nycFixtureLoad({ currentCity: 'Nowhere', currentState: 'ZZ' })
  assert.equal(load.originCity, 'Nashville')
})

test('ED02 is given a load with an ETA, and the id looks like an app load number', () => {
  assert.ok(FIXTURE_LOAD_CASES.has('ED02'))
  assert.ok(FIXTURE_LOAD_CASES.has('ED08'))
  const load = nycFixtureLoad(seattle)
  assert.ok(load.etaAt instanceof Date)
  assert.match(load.id, /^\d{6}$/)
})

// Kills: chat-eval.js going back to its own inline Nashville load, or to
// giving only the case-bank flag a fixture load (ED02 would get none).
test('chat evaluation builds the fixture load from the driver and the case list', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../scripts/chat-eval.js', import.meta.url), 'utf8')
  assert.match(code, /nycFixtureLoad\(ctx\.driver, now\)/)
  assert.match(code, /FIXTURE_LOAD_CASES\.has\(c\.id\)/)
  assert.doesNotMatch(code, /EVAL-NY/)
})

const HOUR = 3600e3
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)

// Kills: an ETA shorter than the drive (ED02: Seattle -> New York "12:17 PM today")
test('the fixture ETA is at least the road time plus the rests a legal driver must take', () => {
  for (const hosRemainingMin of [660, 395, 0, undefined]) {
    const load = nycFixtureLoad({ ...seattle, hosRemainingMin }, NOW)
    const driveH = load.distanceMi / 55
    const needed = driveH + (Math.ceil(driveH / 11) - 1) * 10
    const took = (load.etaAt.getTime() - NOW) / HOUR
    assert.ok(took >= needed, `hos ${hosRemainingMin}: ${took.toFixed(1)}h < ${needed.toFixed(1)}h`)
    assert.equal(load.dispatchedAt.getTime(), NOW)
  }
})

// Kills: a delivery appointment before the ETA
test('the fixture delivery appointment is not before the ETA and the load is not late', () => {
  for (const hosRemainingMin of [660, 395, 0]) {
    const load = nycFixtureLoad({ ...seattle, hosRemainingMin }, NOW)
    assert.ok(load.deliveryAt >= load.etaAt)
    assert.equal(load.deliveryAt.getTime() % HOUR, 0)
    assert.ok(load.deliveryAt.getTime() - load.etaAt.getTime() < HOUR)
    assert.ok(!minutesLate(load), 'not late')
  }
})

// Kills: legalTransitHours ignoring the short first day, the 30-minute break, or the 10-hour rest
test('legalTransitHours is road time, a break past 8 driving hours, and a rest between days', () => {
  assert.equal(legalTransitHours(55 * 5), 5) // 5h, no break due
  assert.equal(legalTransitHours(55 * 9), 9.5) // one day, break
  assert.equal(legalTransitHours(55 * 11), 11.5) // the whole day
  assert.equal(legalTransitHours(55 * 12), 11.5 + 10 + 1) // 11h, rest, 1h
  assert.equal(legalTransitHours(55 * 5, 120), 2 + 10 + 3) // only 2h left today
  assert.equal(legalTransitHours(55 * 5, 0), 10 + 5) // nothing left: rest first
})

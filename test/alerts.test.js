// The alert board's pure parts.
//
// The queries need a database and are covered by sql:check. What is tested
// here is the logic that decides whether a student HEARS something -- the
// acknowledgement rules, and the units the text is written in. Both have a
// failure mode where nothing looks broken: an ack that silences too much,
// or a duration printed on the wrong clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FAMILIES, FAMILY_KEYS, cashFingerprint, fractionRemaining, isLeavingSoon,
  CASH_ACK_RESOLUTION_USD, LEAVING_SOON_FRACTION,
} from '../src/modules/alerts/alerts.catalog.js'
import { simAgo, realAgo } from '../src/modules/alerts/alerts.format.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'

test('every family can produce a whole alert', () => {
  // A family missing one function throws only when that exact condition
  // occurs -- which for cash.limit-reached might be days into a session.
  for (const key of FAMILY_KEYS) {
    const def = FAMILIES[key]
    for (const fn of ['title', 'detail', 'fingerprint', 'href', 'stakeUsd']) {
      assert.equal(typeof def[fn], 'function', `${key}.${fn}`)
    }
  }
})

test('no family is named with a colon -- that separator belongs to the entity id', () => {
  for (const key of FAMILY_KEYS) assert.ok(!key.includes(':'), key)
})

// --- acknowledgement --------------------------------------------------

test('acking a load running behind does not silence it once it is late', () => {
  // The reason fingerprints exist. 'warn' and 'crit' are different
  // situations, and dismissing the smaller one must not hide the larger.
  const behind = FAMILIES['load.running-behind'].fingerprint({ status: 'warn' })
  const late = FAMILIES['load.late'].fingerprint({ status: 'crit' })
  assert.notEqual(behind, late)
})

test('an invoice speaks again on each further simulated day past due', () => {
  const day3 = FAMILIES['invoice.overdue'].fingerprint({ daysPastDue: 3 })
  const day4 = FAMILIES['invoice.overdue'].fingerprint({ daysPastDue: 4 })
  assert.notEqual(day3, day4)
})

test('a cash ack holds through interest ticks but not through $1,000', () => {
  // The tick charges interest every 30 seconds. If the fingerprint were
  // the exact balance, acknowledging "I know I am overdrawn" would last
  // about half a minute and the alert would be useless.
  const base = -4120
  assert.equal(cashFingerprint(base), cashFingerprint(base - 1))
  assert.equal(cashFingerprint(base), cashFingerprint(base - 300))
  assert.notEqual(cashFingerprint(base), cashFingerprint(base - CASH_ACK_RESOLUTION_USD))
  // And in the other direction: paying it down materially is also a
  // different situation.
  assert.notEqual(cashFingerprint(base), cashFingerprint(base + CASH_ACK_RESOLUTION_USD))
})

// --- leaving the market -----------------------------------------------

test('leaving-soon is a fraction of the row\'s own life, not a fixed number of minutes', () => {
  const postedAt = new Date('2026-01-01T00:00:00Z')
  // Two rows with very different lifetimes, both 10% through their last
  // stretch. A minute-based threshold would catch one and miss the other.
  for (const lifetimeMin of [20, 200, 2000]) {
    const expiresAt = new Date(postedAt.getTime() + lifetimeMin * 60000)
    const near = new Date(expiresAt.getTime() - lifetimeMin * 60000 * 0.1)
    const far = new Date(expiresAt.getTime() - lifetimeMin * 60000 * 0.5)
    assert.ok(isLeavingSoon({ postedAt, expiresAt, now: near }), `${lifetimeMin}min: near`)
    assert.ok(!isLeavingSoon({ postedAt, expiresAt, now: far }), `${lifetimeMin}min: far`)
  }
})

test('fractionRemaining is clamped and survives a zero-length window', () => {
  const t = new Date('2026-01-01T00:00:00Z')
  assert.equal(fractionRemaining({ postedAt: t, expiresAt: t, now: t }), 1)
  const later = new Date(t.getTime() + 60000)
  assert.equal(fractionRemaining({ postedAt: t, expiresAt: later, now: t }), 1)
  assert.equal(fractionRemaining({ postedAt: t, expiresAt: later, now: later }), 0)
  // Already expired -- never negative.
  assert.equal(fractionRemaining({ postedAt: t, expiresAt: later, now: new Date(later.getTime() + 60000) }), 0)
  assert.ok(LEAVING_SOON_FRACTION > 0 && LEAVING_SOON_FRACTION < 1)
})

// --- the two clocks, in the text --------------------------------------

test('company events are described in simulated days, marketplace events in real minutes', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  // Three simulated days is six real minutes. Finance says "3 days past
  // due" for the same invoice, so the alert has to say three days too --
  // otherwise the student sees two numbers for one fact and neither is
  // obviously the liar.
  const threeSimDays = new Date(now.getTime() - 3 * REAL_MS_PER_SIM_DAY)
  assert.equal(simAgo(threeSimDays, now), '3 days')
  assert.equal(realAgo(threeSimDays, now), '6 minutes')

  // A broker answering six minutes ago is six minutes ago, because the
  // marketplace runs on the student's own clock.
  const sixMinutes = new Date(now.getTime() - 6 * 60000)
  assert.equal(realAgo(sixMinutes, now), '6 minutes')
})

test('durations are singular when they should be, and never negative', () => {
  const now = new Date('2026-01-01T12:00:00Z')
  assert.equal(simAgo(new Date(now.getTime() - REAL_MS_PER_SIM_DAY), now), '1 day')
  assert.equal(realAgo(new Date(now.getTime() - 60000), now), '1 minute')
  assert.equal(realAgo(new Date(now.getTime() - 5000), now), 'less than a minute')
  // Under a simulated day, hours -- and never "0 hours".
  assert.equal(simAgo(new Date(now.getTime() - REAL_MS_PER_SIM_DAY / 24), now), '1 hour')
  assert.equal(simAgo(new Date(now.getTime() - 1), now), '1 hour')
  // A future timestamp is not a duration.
  assert.equal(simAgo(new Date(now.getTime() + 60000), now), 'not yet')
})

// --- driver.hos-low ----------------------------------------------------

test('driver.hos-low: fingerprint quantizes to whole hours, so a ticking clock does not re-speak', () => {
  const def = FAMILIES['driver.hos-low']
  const at47 = def.fingerprint({ hosRemainingMin: 47 * 60 + 59 })
  const at46 = def.fingerprint({ hosRemainingMin: 46 * 60 })
  assert.equal(at47, 'h47')
  assert.equal(at46, 'h46')
  assert.notEqual(at47, at46, 'a whole hour gone is a different situation')
  // The mutation this kills: a fingerprint of the raw minutes would
  // un-silence the alert on every 30-second tick -- 59min, 58min, ... --
  // which is spam, not an alert.
  assert.notEqual(def.fingerprint({ hosRemainingMin: 47 * 60 }), def.fingerprint({ hosRemainingMin: 47 * 60 - 1 }))
})

test('driver.hos-low: the threshold and the CFR agree', async () => {
  // The alert counts down to the 11-hour limit; the threshold constant
  // must sit inside that limit, not beside it.
  const { HOS_LOW_THRESHOLD_MIN, HOS_LOW_HOUR } = await import('../src/modules/alerts/alerts.catalog.js')
  const { DRIVING_LIMIT_HOURS } = await import('../src/constants/hosClock.js')
  assert.equal(HOS_LOW_HOUR, DRIVING_LIMIT_HOURS)
  assert.ok(HOS_LOW_THRESHOLD_MIN > 0 && HOS_LOW_THRESHOLD_MIN <= DRIVING_LIMIT_HOURS * 60)
})

test('driver.hos-low: the detail names the CFR section it counts down to', () => {
  const detail = FAMILIES['driver.hos-low'].detail({
    loadId: '600009', hosRemainingMin: 45 * 60,
  })
  assert.ok(detail.includes('395.3(a)(3)'), detail)
})

// When things happen, as the models are told it.
//
// On 2026-09-30 the broker told Azizbek a pickup was at 15:06 while the
// load board said 5:06 AM. Both were right about the same moment: the
// board speaks the operation's clock (Central), and the broker's prompt
// interpolated a raw Date, which speaks the SERVER's clock -- Tashkent,
// on the machine that ran it. The broker also had no idea what day it
// was, so "today 15:06, right?" got "That's right -- pickup Friday".
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clockDateTime, clockWhen, relativeDay, clockDateTimeDay } from '../src/constants/appClock.js'
import { buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'

// Wed Sep 30 2026, 8:53 AM Central (13:53 UTC -- 6:53 PM in Tashkent).
const NOW = new Date('2026-09-30T13:53:00Z')
// Fri Oct 2, 5:06 AM Central -- "15:06" on a Tashkent server.
const PICKUP = new Date('2026-10-02T10:06:00Z')
const DELIVERY = new Date('2026-10-03T02:00:00Z') // Fri Oct 2, 9:00 PM Central

const BROKER = { contactName: 'Dana Pruitt', name: 'Redstone Freight', persona: 'Direct, busy, fair.' }
const POSTING = {
  id: 'p-1', originCity: 'Dover', originState: 'DE', destinationCity: 'Peoria', destinationState: 'IL',
  distanceMi: 887, commodity: 'paper goods', weightLbs: 38000, equipmentType: 'Dry Van', equipmentLengthFt: 53,
  rateHidden: false, rateUsd: 2244, pickupAt: PICKUP, deliveryAt: DELIVERY,
}

// Kills: going back to Intl without a timeZone, or to toLocaleString --
// both speak the server's zone again.
test('a date-time is the day, the date and the hour on the operation clock', () => {
  assert.equal(clockDateTime(PICKUP.toISOString()), 'Fri, Oct 2, 5:06 AM')
  assert.equal(clockDateTime(null), null)
  assert.equal(clockDateTime('not a date'), null)
})

// Kills: always printing the bare hour (an ETA a day out lands on the
// wrong day in the listener's head) -- and always printing the date
// (nobody says today's date out loud).
test('a time names its day only when it is not today', () => {
  assert.equal(clockWhen('2026-09-30T23:30:00Z', NOW.toISOString()), '6:30 PM')
  assert.equal(clockWhen('2026-10-01T23:30:00Z', NOW.toISOString()), 'Thu, Oct 1, 6:30 PM')
})

// Kills: interpolating the Date object itself. Whatever zone the server
// runs in, the prompt must say what the board says.
test('the broker is told pickup and delivery on the board\'s clock, never the server\'s', () => {
  const prompt = buildBrokerSystemPrompt({ broker: BROKER, posting: POSTING, now: NOW })
  assert.match(prompt, /Pickup: Fri, Oct 2, 5:06 AM \(in 2 days\)\n  Delivery: Fri, Oct 2, 9:00 PM \(in 2 days\)\n  \(Central Time/)
  assert.doesNotMatch(prompt, /GMT|Standard Time|15:06/, 'server vaqt zonasidagi sana promptga tushdi')
})

// Kills: dropping the "right now" line. Two dates and no calendar is how
// "today" turned into "Friday".
test('the broker knows what day and time it is', () => {
  const prompt = buildBrokerSystemPrompt({ broker: BROKER, posting: POSTING, now: NOW })
  assert.match(prompt, /It is Wed, Sep 30, 8:53 AM Central time/)
})

// Kills: leaving "tomorrow" for the model to work out. On 2026-10-05 a
// broker given a Tuesday pickup and a Tuesday delivery on a Monday said
// "delivery by 9:40 tonight" -- before its own pickup. The day word is
// computed on the company clock: 04:00 UTC on Oct 1 is still Sep 30 in
// Chicago.
test('the day is spelled out relative to now, on the company clock', () => {
  const now = NOW.toISOString() // Wed, Sep 30, 8:53 AM Central
  assert.equal(relativeDay('2026-09-30T23:30:00Z', now), 'today')
  assert.equal(relativeDay('2026-10-01T04:30:00Z', now), 'today')
  assert.equal(relativeDay('2026-10-01T15:00:00Z', now), 'tomorrow')
  assert.equal(relativeDay('2026-09-29T15:00:00Z', now), 'yesterday')
  assert.equal(relativeDay('2026-10-03T15:00:00Z', now), 'in 3 days')
  assert.equal(relativeDay('2026-09-27T15:00:00Z', now), '3 days ago')
  assert.equal(relativeDay(null, now), null)
  assert.equal(clockDateTimeDay('2026-10-01T15:00:00Z', now), 'Thu, Oct 1, 10:00 AM (tomorrow)')
})

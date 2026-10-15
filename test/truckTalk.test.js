// Where the dispatcher says the truck is, against the posting's pickup
// (truckTalk.js and the broker prompt's truckBlock). Born of live:56
// (2026-10-15): "my truck is in seattle right now, can she make it?" was
// ignored by the broker. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truckCity, truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { truckBlock, buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { findCity, roadMiles } from '../scripts/seed/cities.js'
import { legalTransitHours } from '../src/modules/loads/whereabouts.js'

// Tuesday 9:28 AM Central.
const NOW = new Date(Date.UTC(2026, 9, 13, 14, 28))
const posting = (pickupAt) => ({
  originCity: 'Dallas', originState: 'TX', destinationCity: 'Atlanta', destinationState: 'GA',
  pickupAt, equipmentType: 'dry-van', rateUsd: 3000, distanceMi: 800,
})
const tomorrow8 = new Date(Date.UTC(2026, 9, 14, 13, 0)) // Wed 8:00 AM Central
const friday8 = new Date(Date.UTC(2026, 9, 16, 13, 0))

// Kills: the truck's city taken from any city in the message (the load's own)
test('the truck city is the one straight after "truck is in / at / out of" or "empty in"', () => {
  assert.deepEqual(truckCity(['my truck is in seattle right now, can she make it?']), { city: 'Seattle', state: 'WA' })
  assert.deepEqual(truckCity(["my truck's in Seattle, WA"]), { city: 'Seattle', state: 'WA' })
  assert.equal(truckCity(['truck at tacoma'])?.city, 'Tacoma')
  assert.equal(truckCity(['truck out of boise'])?.city, 'Boise')
  assert.equal(truckCity(["i'm empty in denver, can do"])?.city, 'Denver')
  // The load's city, a rate talk, a question about the truck: not a location.
  assert.equal(truckCity(['is the dallas pickup a live load?']), null)
  assert.equal(truckCity(['my truck is a 53 ft van, load to seattle ok?']), null)
  assert.equal(truckCity(['what is the rate']), null)
  assert.equal(truckCity(['my truck is in a rush, the dallas load is ok?']), null)
  // The latest message that says it wins.
  assert.equal(truckCity(['truck is in seattle', "ok, now i'm empty in reno"])?.city, 'Reno')
})

// Kills: miles taken from anywhere but the truck's city to the posting's origin
test('miles are the road miles from the truck to the posting origin', () => {
  const f = truckFacts({ texts: ['my truck is in seattle right now, can she make it?'], posting: posting(friday8), now: NOW })
  assert.equal(f.miles, roadMiles(findCity('Seattle', 'WA'), findCity('Dallas', 'TX')))
  assert.equal(f.miles, 1982)
  assert.equal(truckFacts({ texts: ['hi'], posting: posting(friday8), now: NOW }), null)
  // A truck city the list does not know: no fact, no invented figure.
  assert.equal(truckFacts({ texts: ['truck is in zzzville'], posting: posting(friday8), now: NOW }), null)
})

// Kills: rests ignored, or the driver's hours assumed to be something other than a full day
test('earliest arrival is a full day plus rests, and it is before or after the pickup', () => {
  const f = truckFacts({ texts: ['truck is in seattle'], posting: posting(tomorrow8), now: NOW })
  assert.equal(f.earliestAt.getTime(), Math.floor(NOW.getTime() + legalTransitHours(1982, 660) * 3600e3))
  assert.equal(f.makesIt, false)
  assert.equal(truckFacts({ texts: ['truck is in seattle'], posting: posting(new Date(Date.UTC(2026, 9, 20, 13, 0))), now: NOW }).makesIt, true)
})

// Kills: the block printed with no city said, or the after / before wording swapped
test('the broker prompt has the truck block only when a city was said, and says after or before', () => {
  assert.deepEqual(truckBlock({ posting: posting(tomorrow8), said: ['what is the rate'], now: NOW }), [])
  assert.deepEqual(truckBlock({ posting: posting(tomorrow8), said: null, now: NOW }), [])

  const late = truckBlock({ posting: posting(tomorrow8), said: ['my truck is in seattle right now, can she make it?'], now: NOW }).join('\n')
  assert.match(late, /They said the truck is in Seattle, WA: about 1,982 road miles from Dallas, TX\./)
  assert.match(late, /a full day is assumed\) it gets there around \w{3}, Oct 1\d, [\d:]+ [AP]M -- after your Wed, Oct 14, 8:00 AM \(tomorrow\) pickup\./)
  assert.match(late, /Never send them to check with anyone\./)

  const early = truckBlock({ posting: posting(new Date(Date.UTC(2026, 9, 20, 13, 0))), said: ['truck is in seattle'], now: NOW }).join('\n')
  assert.match(early, / -- before your Tue, Oct 20, 8:00 AM \(in 7 days\) pickup\./)
})

// Kills: the truck already at the pickup city described as "0 road miles"
test('a truck already in the pickup city says so, with no miles', () => {
  const text = truckBlock({ posting: posting(tomorrow8), said: ['truck is in dallas'], now: NOW }).join('\n')
  assert.match(text, /the truck is in Dallas, TX, which is your pickup city\./)
  assert.doesNotMatch(text, /road miles/)
})

// Kills: the block not reaching the prompt the model reads
test('the block is inside the full broker prompt, before HOW YOU TALK', () => {
  const args = {
    broker: { name: 'Acme Freight', contactName: 'Dan', persona: 'dry and quick' },
    posting: { ...posting(tomorrow8), commodity: 'paper', weightLbs: 30000, equipmentLengthFt: 53, rateHidden: false },
    now: NOW,
  }
  const without = buildBrokerSystemPrompt({ ...args, said: ['hi'] })
  assert.doesNotMatch(without, /WHERE THEY SAID THEIR TRUCK IS/)
  const withIt = buildBrokerSystemPrompt({ ...args, said: ['my truck is in seattle right now, can she make it?'] })
  assert.match(withIt, /WHERE THEY SAID THEIR TRUCK IS/)
  assert.ok(withIt.indexOf('WHERE THEY SAID THEIR TRUCK IS') < withIt.indexOf('HOW YOU TALK'))
})

// Kills: "sitting / parked / empty in X" accepted without a truck or driver
// as the subject (a trailer, the dispatcher's own chair)
test('sitting, parked and empty count only with a truck, driver, I or we as the subject', () => {
  assert.equal(truckCity(['sitting in austin lol']), null)
  assert.equal(truckCity(['our trailer parked at dallas']), null)
  assert.equal(truckCity(['empty in denver']), null)
  assert.equal(truckCity(['the trailer is in dallas']), null)
  assert.equal(truckCity(["we're parked at tacoma"])?.city, 'Tacoma')
  assert.equal(truckCity(['truck empty in boise'])?.city, 'Boise')
  assert.equal(truckCity(['my driver is in reno'])?.city, 'Reno')
})

// Kills: a statement from five messages ago still driving the block
test('only the last four dispatcher messages are read', () => {
  const old = 'my truck is in seattle'
  assert.equal(truckCity([old, 'a', 'b', 'c'])?.city, 'Seattle')
  assert.equal(truckCity([old, 'a', 'b', 'c', 'd']), null)
})

// Kills: an older truck city used after a newer message moved the truck
test('the newest statement wins over an older one', () => {
  assert.equal(truckCity(['truck is in seattle', 'truck is in reno now', 'what is the rate'])?.city, 'Reno')
})

// Kills: a plan for later read as where the truck is now, or an older
// present statement used instead when the newest one is about later
test('"tomorrow", "next week" and "will be" give no current location, and do not fall back to an older one', () => {
  assert.equal(truckCity(['truck will be in reno tomorrow']), null)
  assert.equal(truckCity(['tomorrow my truck will be in seattle']), null)
  assert.equal(truckCity(['next week the truck is in denver']), null)
  assert.equal(truckCity(['truck is in seattle', 'truck will be in reno next week']), null)
  // A question about later after a present location is still a present location.
  assert.equal(truckCity(['truck is in seattle, can she make it by tomorrow?'])?.city, 'Seattle')
})

// Kills: a future statement reaching the prompt as a fact
test('a truck that will be somewhere later produces no block', () => {
  assert.deepEqual(truckBlock({ posting: posting(tomorrow8), said: ['my truck will be in seattle tomorrow'], now: NOW }), [])
})

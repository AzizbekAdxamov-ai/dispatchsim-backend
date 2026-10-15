// A load the dispatcher mentions to Grace, read by code (offerTalk.js), and
// the block of facts the prompt gets from it. Born of live:60-62 and ED07
// (2026-10-15): "pu tmrw 3am" from Pittsburgh to a driver in Seattle was
// answered "Copy", and later "about 2,500 mi, so roughly 45 hours".
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placesIn, pickupCity, pickupWhen, offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { buildDriverSystemPrompt, offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { findCity, roadMiles } from '../scripts/seed/cities.js'
import { legalTransitHours } from '../src/modules/loads/whereabouts.js'

// Tuesday 9:28 AM Central (CDT, UTC-5).
const NOW = new Date(Date.UTC(2026, 9, 13, 14, 28))
const seattle = { currentCity: 'Seattle', currentState: 'WA', hosRemainingMin: 660 }
const central = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit',
}).format(d)

// Kills: case-sensitive findCity (it is exact-match, so "dallas" found nothing)
test('a city typed in lower case, with or without its state, is found', () => {
  for (const text of ['got a dallas load', 'got a Dallas, TX load', 'got a dallas tx load', 'DALLAS load']) {
    const [hit, ...rest] = placesIn(text)
    assert.equal(`${hit.city}, ${hit.state}`, 'Dallas, TX', text)
    assert.equal(rest.length, 0)
  }
  assert.equal(placesIn('kansas city to st louis')[0].city, 'Kansas City')
  assert.equal(placesIn('kansas city to st louis')[1].city, 'St. Louis')
})

// Kills: substring matching (a city inside another word)
test('a city name inside another word is not a city', () => {
  for (const text of ['dallasville load', 'the redallas', 'unaustin', 'salemate', 'nycity']) {
    assert.deepEqual(placesIn(text), [], text)
  }
})

// Kills: first match taken (Portland, ME was guessed to be Portland, OR)
test('a name several states share, with no state beside it, is no match', () => {
  assert.deepEqual(placesIn('got a portland load'), [])
  assert.equal(pickupCity('got a portland load pu tmrw 8am'), null)
  assert.equal(placesIn('portland me')[0].state, 'ME')
  assert.equal(placesIn('portland, or')[0].state, 'OR')
  // "in" and "to" after a city are words, not Indiana and nothing.
  assert.equal(placesIn('dallas to raleigh').length, 2)
  // The pickup is the Portland nobody could place, not the Dallas beside it.
  assert.equal(pickupCity('portland to dallas tx pu wed 3pm'), null)
})

// Kills: the short forms ignored (or an alias table that grew past nyc and philly)
test('nyc and philly are the two aliases', () => {
  assert.equal(placesIn('nyc')[0].city, 'New York')
  assert.equal(placesIn('philly')[0].state, 'PA')
  assert.deepEqual(placesIn('chi'), [])
})

// Kills: the pickup taken as the last city (or the destination)
test('in "X to Y" the pickup is X; otherwise the one city next to load / pu', () => {
  assert.equal(pickupCity('got a load pittsburgh to raleigh pu tmrw 3am').city, 'Pittsburgh')
  assert.equal(pickupCity('got a dallas load next, pu tmrw 8am').city, 'Dallas')
  assert.equal(pickupCity('pu in tacoma then drop in dallas').city, 'Tacoma')
  // Her own city is not the pickup of something offered to her.
  assert.equal(pickupCity('seattle to dallas', { except: { city: 'Seattle', state: 'WA' } }), null)
  assert.equal(pickupCity('how are you'), null)
})

// Kills: UTC parsing (8am read as 8:00Z = 3 AM Central)
test('"pu tmrw 8am" on Tuesday 9:28 AM Central is Wednesday 8:00 AM Central', () => {
  assert.equal(pickupWhen('Grace got a dallas load, pu tmrw 8am', NOW).toISOString(), '2026-10-14T13:00:00.000Z')
  assert.equal(central(pickupWhen('pu tmrw 8am', NOW)), 'Wed 8:00 AM')
  assert.equal(central(pickupWhen('pu tomorrow 3 am', NOW)), 'Wed 3:00 AM')
  assert.equal(central(pickupWhen('pu today 15:00', NOW)), 'Tue 3:00 PM')
  assert.equal(central(pickupWhen('pu friday 12pm', NOW)), 'Fri 12:00 PM')
  assert.equal(central(pickupWhen('pu tue 8am', NOW)), 'Tue 8:00 AM')
  // A day with no hour, an hour with no day, a number that is no hour: not guessed.
  assert.equal(pickupWhen('pu tmrw', NOW), null)
  assert.equal(pickupWhen('pu 8am', NOW), null)
  assert.equal(pickupWhen('2500 miles tmrw', NOW), null)
})

// Kills: a weekday read as always today, or a past hour read as still ahead
test('a weekday that is today but already past means next week', () => {
  const next = pickupWhen('pu tue 8am', NOW)
  assert.equal(next.toISOString(), '2026-10-20T13:00:00.000Z')
  assert.equal(pickupWhen('pu tue 3pm', NOW).toISOString(), '2026-10-13T20:00:00.000Z')
})

// Kills: a clock change ignored (CDT -> CST on Nov 1)
test('after the clock change the same wall hour is an hour later in UTC', () => {
  const fri = new Date(Date.UTC(2026, 10, 2, 15, 0)) // Mon Nov 2, 9:00 AM CST
  assert.equal(pickupWhen('pu tmrw 8am', fri).toISOString(), '2026-11-03T14:00:00.000Z')
})

// Kills: rests ignored (miles / 55 as the drive time)
test('Seattle to Dallas and to Pittsburgh cannot be made by the pickup time they name', () => {
  const dallas = offerFacts({ driver: seattle, texts: ['Grace got a dallas load next, pu tmrw 8am'], now: NOW })
  assert.equal(dallas.city, 'Dallas')
  assert.equal(dallas.miles, roadMiles(findCity('Seattle', 'WA'), findCity('Dallas', 'TX')))
  assert.equal(dallas.makesIt, false)
  const pitt = offerFacts({ driver: seattle, texts: ['Grace got a load pittsburgh to raleigh pu tmrw 3am'], now: NOW })
  assert.equal(pitt.city, 'Pittsburgh')
  assert.equal(pitt.makesIt, false)
  // Same drive, same pickup, but only the road time counted: it would "make" it.
  const naiveArrival = NOW.getTime() + (pitt.miles / 55) * 3600e3
  const thursday8 = pickupWhen('pu thu 8am', NOW)
  assert.ok(naiveArrival < thursday8.getTime(), 'miles / 55 alone would arrive before Thursday 8 AM')
  const real = offerFacts({ driver: seattle, texts: ['got a load pittsburgh to raleigh pu thu 8am'], now: NOW })
  assert.equal(real.makesIt, false)
  assert.equal(real.earliestAt.getTime(), Math.floor(NOW.getTime() + legalTransitHours(pitt.miles, 660) * 3600e3))
  assert.ok(real.earliestAt.getTime() - NOW.getTime() >= (pitt.miles / 55 + 3 * 10) * 3600e3)
})

// Kills: hosRemainingMin ignored (a driver with no hours left started driving at once)
test('a pickup that is reachable with a full day is not with no hours left', () => {
  const text = 'got a spokane load, pu today 6pm'
  assert.equal(offerFacts({ driver: seattle, texts: [text], now: NOW }).makesIt, true)
  assert.equal(offerFacts({ driver: { ...seattle, hosRemainingMin: 0 }, texts: [text], now: NOW }).makesIt, false)
})

// Kills: a near load reported as unreachable (a verdict that is always "cannot")
test('a nearby load with a day to get there is reachable', () => {
  const o = offerFacts({ driver: seattle, texts: ['Grace got a spokane load, pu tmrw 6pm'], now: NOW })
  assert.equal(o.makesIt, true)
  assert.ok(o.earliestAt.getTime() < o.pickupAt.getTime())
})

// Kills: first-match-only time (live:61 said the time one message earlier)
test('a pickup time said a message earlier still counts', () => {
  const o = offerFacts({ driver: seattle, texts: ['pu tmrw 3am', 'ok its a dallas load'], now: NOW })
  assert.equal(o.city, 'Dallas')
  assert.equal(o.makesIt, false)
})

// Kills: invented default distance (a city off the list getting a number anyway)
test('a place the list does not know gets no figure, and the prompt says to ask', () => {
  const o = offerFacts({ driver: seattle, texts: ['Grace got a zzzville load, pu tmrw 8am'], now: NOW })
  assert.equal(o.miles, null)
  assert.equal(o.earliestAt, null)
  assert.equal(o.makesIt, null)
  const lines = offerLines(o).join('\n')
  assert.match(lines, /do not know how far zzzville is; ask for the miles, never guess one/)
  assert.doesNotMatch(lines, /\d/)
  // A known city but a driver place off the list: also no figure.
  const lost = offerFacts({ driver: { currentCity: 'Nowhere', currentState: 'ZZ' }, texts: ['got a dallas load'], now: NOW })
  assert.equal(lost.miles, null)
  // A freight word before "load" is not a place.
  assert.equal(offerFacts({ driver: seattle, texts: ['got a reefer load for you'], now: NOW }), null)
})

// Kills: eta_at read as wall clock (a time verdict while she is on a load)
test('on a load she gets only the miles from where it delivers, no time verdict', () => {
  const load = { originCity: 'Seattle', originState: 'WA', destinationCity: 'Nashville', destinationState: 'TN' }
  const o = offerFacts({ driver: seattle, load, texts: ['got a dallas load, pu tmrw 8am'], now: NOW })
  assert.equal(o.onLoad, true)
  assert.equal(o.miles, roadMiles(findCity('Nashville', 'TN'), findCity('Dallas', 'TX')))
  assert.equal(o.earliestAt, null)
  assert.equal(o.makesIt, null)
  const lines = offerLines(o).join('\n')
  assert.match(lines, /from Nashville, TN, where the load you are on delivers/)
  assert.doesNotMatch(lines, /earliest|cannot make it|can make it/)
  // The load she is already on, named, is not an offer.
  const same = offerFacts({ driver: seattle, load, texts: ['ur on the nashville load'], now: NOW })
  assert.equal(same, null)
})

const base = {
  driver: {
    name: 'Grace Lindqvist', cdlClass: 'A', payModel: 'permile', payPerMileCents: 63, homeBaseCity: 'Seattle', homeBaseState: 'WA',
    currentCity: 'Seattle', currentState: 'WA', dutyStatus: 'off', hosRemainingMin: 660,
  },
  standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
  load: null,
  now: NOW,
}

// Kills: block always printed (the heading with no load on the table)
test('the prompt has no offer block without a fact, and has it with one', () => {
  assert.doesNotMatch(buildDriverSystemPrompt(base), /THE LOAD DISPATCH JUST MENTIONED:/)
  const offer = offerFacts({ driver: base.driver, texts: ['Grace got a dallas load next, pu tmrw 8am'], now: NOW })
  const prompt = buildDriverSystemPrompt({ ...base, offer })
  assert.match(prompt, /THE LOAD DISPATCH JUST MENTIONED:\n {2}Pickup in Dallas, TX is about 1,982 road miles from where you are\./)
  assert.match(prompt, /Driving it legally \(11 hours a day, a 10-hour rest between days\) the earliest you could be there is \w{3}, Oct 1\d,/)
  assert.match(prompt, /The pickup they said is Wed, Oct 14, 8:00 AM -- you cannot make it\./)
  // After the situation lines, before the personality / pay blocks.
  assert.ok(prompt.indexOf('WHERE YOU ARE, RIGHT NOW') < prompt.indexOf('THE LOAD DISPATCH JUST MENTIONED:'))
  assert.ok(prompt.indexOf('THE LOAD DISPATCH JUST MENTIONED:') < prompt.indexOf('YOUR PAY, AS IT STANDS'))
})

// Kills: a verdict without a pickup time (the line printed with "Invalid Date")
test('with no pickup time the prompt gives the miles and the earliest, no verdict', () => {
  const offer = offerFacts({ driver: base.driver, texts: ['got a dallas load'], now: NOW })
  const lines = offerLines(offer).join('\n')
  assert.match(lines, /road miles from where you are/)
  assert.match(lines, /earliest you could be there/)
  assert.doesNotMatch(lines, /The pickup they said|can make it|cannot make it|Invalid/)
  assert.match(offerLines({ ...offer, pickupAt: new Date(NOW.getTime() + 1e9), makesIt: true }).join('\n'), /you can make it\./)
})

// Kills: the "react like a driver, do not turn it down" rule lost
test('the prompt tells her to say she cannot make it and ask for later, not to refuse', () => {
  const prompt = buildDriverSystemPrompt(base)
  assert.match(prompt, /if you cannot make the pickup, say so with the miles written there and\n\s+ask for a later time -- you do not turn the load down\./)
  assert.match(prompt, /Never give miles\n\s+or hours that are not written above\./)
})

// Kills: the service not passing the offer to the prompt (a source check: the
// service needs a database, which a unit test does not have)
test('the driver chat service passes the offer to the prompt, built from this message and the last four', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../src/modules/driverChat/driverChat.service.js', import.meta.url), 'utf8')
  assert.match(code, /offer: offerFacts\(\{/)
  assert.match(code, /\.slice\(-4\)\.map\(\(m\) => m\.content\), text\]/)
})

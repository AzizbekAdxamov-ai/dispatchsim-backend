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

// Kills: the first day and hour in an offer accepted as pickup even when labeled delivery.
test('delivery time is not treated as the pickup time of a Dallas offer', () => {
  const text = 'got a dallas load, delivery tomorrow 8am'
  assert.equal(pickupWhen(text, NOW), null)
  const offer = offerFacts({ driver: seattle, texts: [text], now: NOW })
  assert.equal(offer.city, 'Dallas')
  assert.equal(offer.pickupAt, null)
  assert.equal(offer.makesIt, null)
  assert.equal(pickupWhen('got a dallas load, pu tomorrow 8am, delivery Friday 5pm', NOW).toISOString(), '2026-10-14T13:00:00.000Z')
})

// Kills: returning null after the first delivery date hides a later explicit pickup date.
test('a pickup time after a delivery time still belongs to the offer', () => {
  const now = new Date('2026-10-15T15:00:00Z')
  const text = 'got a dallas load, delivery tomorrow 8am, pu Friday 5pm'
  assert.equal(pickupWhen(text, now).toISOString(), '2026-10-16T22:00:00.000Z')
  const offer = offerFacts({ driver: seattle, texts: [text], now })
  assert.equal(offer.pickupAt.toISOString(), '2026-10-16T22:00:00.000Z')
  assert.equal(pickupWhen('got a dallas load, pu Friday 5pm, delivery tomorrow 8am', now).toISOString(), '2026-10-16T22:00:00.000Z')
})

// Kills: a later delivery hour paired with an earlier pickup day.
test('an hour stated only for delivery does not complete a pickup day', () => {
  const now = new Date('2026-10-15T15:00:00Z')
  assert.equal(pickupWhen('got a dallas load, pickup tomorrow, delivery Friday 8am', now), null)
  assert.equal(pickupWhen('got a dallas load, pickup tomorrow, delivery 8am Friday', now), null)
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

// -- Review round 2 -------------------------------------------------------------

// Kills: a stale time attaching to a new city (Dallas inheriting "tmrw 3am"
// said about Pittsburgh)
test('a time said about another city is not carried to the new city', () => {
  const o = offerFacts({ driver: seattle, texts: ['got a load pittsburgh to raleigh pu tmrw 3am', 'ok what about dallas to austin'], now: NOW })
  assert.equal(o.city, 'Dallas')
  assert.equal(o.pickupAt, null)
  assert.equal(o.makesIt, null)
})

// Kills: live:60 -> live:61 broken -- the same load talked about again must keep its time
test('the same city named again keeps the earlier time, and a later message can bring the time', () => {
  const again = offerFacts({ driver: seattle, texts: ['got a load pittsburgh to raleigh pu tmrw 3am', 'can u make pittsburgh by 3am tho?'], now: NOW })
  assert.equal(again.city, 'Pittsburgh')
  assert.equal(again.makesIt, false)
  assert.equal(central(again.pickupAt), 'Wed 3:00 AM')
  const samePu = offerFacts({ driver: seattle, texts: ['got a load pittsburgh to raleigh pu tmrw 3am', 'pu pittsburgh by 3am ok?'], now: NOW })
  assert.equal(central(samePu.pickupAt), 'Wed 3:00 AM')
  // The time in a newer message belongs to the load named before it.
  const later = offerFacts({ driver: seattle, texts: ['got a dallas load', 'pu tmrw 8am'], now: NOW })
  assert.equal(later.city, 'Dallas')
  assert.equal(central(later.pickupAt), 'Wed 8:00 AM')
  // A different city in between ends the carry.
  const between = offerFacts({ driver: seattle, texts: ['pu tmrw 3am', 'got a spokane load', 'what about a dallas load'], now: NOW })
  assert.equal(between.city, 'Dallas')
  assert.equal(between.pickupAt, null)
})

// Kills: "ur on the NYC load" with no load in the database read as an offer
test('a statement about the load she is on offers nothing, with or without a load in the database', () => {
  for (const text of ['ur on the NYC load', "you're on the dallas load", 'your dallas load is set', 'you are on dallas']) {
    assert.equal(offerFacts({ driver: seattle, texts: [text], now: NOW }), null, text)
  }
  // "your next load" is an offer.
  assert.equal(offerFacts({ driver: seattle, texts: ['your next load: dallas pu tmrw 8am'], now: NOW })?.city, 'Dallas')
})

// Kills: a common word that is also a city read as a pickup
test('mobile, jackson and austin as ordinary words are not loads', () => {
  for (const text of ['got a load jackson called me about', 'load: mobile app is down', 'hey austin, any load? reading the board']) {
    assert.equal(offerFacts({ driver: seattle, texts: [text], now: NOW }), null, text)
    assert.deepEqual(placesIn(text), [], text)
  }
  assert.equal(offerFacts({ driver: seattle, texts: ['got a dallas load'], now: NOW }).city, 'Dallas')
})

// Kills: an order cue not rescuing a common-word city (the guard dropping them all)
test('a common-word city with an order cue is a pickup', () => {
  assert.equal(pickupCity('got a load in mobile pu tmrw 8am')?.city, 'Mobile')
  assert.equal(pickupCity('load from jackson tmrw')?.city, 'Jackson')
  assert.equal(pickupCity('pu austin tmrw 8am')?.city, 'Austin')
  assert.equal(pickupCity('pu in madison tmrw 8am')?.city, 'Madison')
  assert.equal(pickupCity('got a lincoln load')?.city, 'Lincoln')
  assert.equal(pickupCity('augusta to dallas')?.city, 'Augusta')
  assert.equal(pickupCity('pickup in columbia')?.city, 'Columbia')
})

// Kills: an offer block shown to a driver who refuses or has quit (the stance
// says turn it down; the offer rule says do not)
test('the offer block is shown only while she still takes work', () => {
  const offer = offerFacts({ driver: base.driver, texts: ['got a dallas load, pu tmrw 8am'], now: NOW })
  for (const stage of ['ok', 'asks']) {
    assert.match(buildDriverSystemPrompt({ ...base, standing: { ...base.standing, stage }, offer }), /THE LOAD DISPATCH JUST MENTIONED:/, stage)
  }
  for (const stage of ['refuses', 'quits']) {
    const prompt = buildDriverSystemPrompt({ ...base, standing: { ...base.standing, stage, unpaidCount: 1, owedUsd: 900, daysOverdue: 9 }, offer })
    assert.doesNotMatch(prompt, /THE LOAD DISPATCH JUST MENTIONED:/, stage)
  }
  assert.match(buildDriverSystemPrompt({ ...base, standing: { ...base.standing, stage: 'refuses', unpaidCount: 1, owedUsd: 900, daysOverdue: 9 }, offer }), /If they offer you a load, turn it down/)
})

// Kills: an unknown driving time assumed to be a full day
test('with no driving time known there are miles but no arrival time or verdict', () => {
  const o = offerFacts({ driver: { ...seattle, hosRemainingMin: null }, texts: ['got a dallas load, pu tmrw 8am'], now: NOW })
  assert.equal(o.miles, 1982)
  assert.equal(o.earliestAt, null)
  assert.equal(o.makesIt, null)
  const lines = offerLines(o).join('\n')
  assert.match(lines, /1,982 road miles from where you are/)
  assert.doesNotMatch(lines, /earliest|cannot make it|can make it/)
  // Zero minutes left is known, not unknown.
  assert.equal(offerFacts({ driver: { ...seattle, hosRemainingMin: 0 }, texts: ['got a spokane load'], now: NOW }).earliestAt instanceof Date, true)
})

// Kills: the clock change ignored across the night it happens (Nov 1, 2026, 2 AM)
test('tomorrow 8 AM from Saturday evening, across the end of daylight time, is 14:00Z', () => {
  const sat7pm = new Date(Date.UTC(2026, 10, 1, 0, 0)) // Sat Oct 31, 7:00 PM CDT
  assert.equal(pickupWhen('pu tmrw 8am', sat7pm).toISOString(), '2026-11-01T14:00:00.000Z')
  // 5 AM that night exists only after the change: 05:00 CST = 11:00Z (needs the second offset pass).
  assert.equal(pickupWhen('pu tmrw 5am', sat7pm).toISOString(), '2026-11-01T11:00:00Z'.replace('Z', '.000Z'))
  // The same wall hour the day before the change is 13:00Z.
  assert.equal(pickupWhen('pu tmrw 8am', new Date(Date.UTC(2026, 9, 31, 0, 0))).toISOString(), '2026-10-31T13:00:00.000Z')
})

// Kills: "today" with an hour already gone treated as tomorrow, or as ahead
test('today with an hour that has already passed is that hour today, in the past, and cannot be made', () => {
  const past = pickupWhen('pu today 8am', NOW)
  assert.equal(past.toISOString(), '2026-10-13T13:00:00.000Z')
  assert.ok(past.getTime() < NOW.getTime())
  const o = offerFacts({ driver: seattle, texts: ['got a spokane load, pu today 8am'], now: NOW })
  assert.equal(o.makesIt, false)
})

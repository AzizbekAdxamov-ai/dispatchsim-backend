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

import { situationLines, buildDriverSystemPrompt, humanDuration } from '../src/modules/driverChat/driverChat.prompt.js'

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
  assert.match(text({ driver: DRIVER, load: LOAD }), /Driving time left today: 6 hours 35 minutes\./)
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
  assert.match(out, /It is Tue, Sep 29, 1:00 PM \(Central time\) where the load is\./)
  assert.doesNotMatch(out, /23:30|18:00/)
})

// Kills: leaving the driver to work out from two timestamps that they
// are late -- they are the one watching the miles, and they would know
// first. Arithmetic belongs here, not in the model.
test('running late is stated, with how late', () => {
  assert.match(text({ driver: DRIVER, load: LOAD }), /2 hours 30 minutes past the appointment/)
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

// Kills: lateness left to the model's wording -- 27 hours late came out as
// "running a bit late" (2026-10-06 scenario run).
test('a late driver is told to say how late in hours', () => {
  const late = situationLines({
    driver: { currentCity: 'Toledo', currentState: 'OH', dutyStatus: 'driving' },
    load: { originCity: 'Nashville', originState: 'TN', destinationCity: 'New York', destinationState: 'NY', etaAt: '2026-10-06T13:20:00Z', deliveryAt: '2026-10-05T09:46:00Z' },
    now: new Date('2026-10-06T13:00:00Z'),
  }).join('\n')
  assert.match(late, /past the appointment\. You know you are running late; if it comes up, say by how much, never "a bit"\./)
})

// Kills: the general on-duty line ("fuelling, loading, a walkaround") on
// a driver mid-run. On 2026-10-06 (fourth run) Grace, on the road near New
// York, said "waiting on the dock, box is loaded".
test('on duty on the road is a stop on the road, not a dock', () => {
  const onRun = text({ driver: { ...DRIVER, dutyStatus: 'on-duty', onTheRoad: true }, load: LOAD })
  assert.match(onRun, /stopped on the road for fuel or a walkaround\. You are not at a dock\./)
  assert.doesNotMatch(onRun, /loading/)
  const parked = text({ driver: { ...DRIVER, dutyStatus: 'on-duty' }, load: null })
  assert.match(parked, /fuelling, loading, a walkaround/)
})

// Kills: "at the drop" from a driver on the road, "in a bit" for an hour
// she has, "let me look at the paperwork", and "the shipper" at the
// delivery end -- all from the fourth 2026-10-06 run.
test('the driver says where and when as written, and promises no paperwork check', () => {
  const p = buildDriverSystemPrompt({
    driver: DRIVER, load: LOAD, now: NOW,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
  })
  assert.match(p, /on the road near a city is not at the dock there/)
  assert.match(p, /the\s+hour you are due is an hour, not "a bit"/)
  assert.match(p, /never say "let me look", "let me check"/)
  assert.match(p, /Where you pick up is the shipper; where you deliver is the receiver\./)
})

// Kills: machine durations ("11h 00m") reaching the model, which copies
// them into the text (ED01/ED10, 2026-10-12); or rounding the minutes.
test('durations are phrased like a person, exactly', () => {
  assert.equal(humanDuration(660), '11 hours')
  assert.equal(humanDuration(395), '6 hours 35 minutes')
  assert.equal(humanDuration(60), '1 hour')
  assert.equal(humanDuration(61), '1 hour 1 minute')
  assert.equal(humanDuration(45), '45 minutes')
  assert.equal(humanDuration(null), null)
  assert.equal(humanDuration(0), '0 minutes')
  assert.equal(humanDuration(59), '59 minutes')
  assert.equal(humanDuration(120), '2 hours')
  assert.equal(humanDuration(-30), '0 minutes')
  const out = text({ driver: { ...DRIVER, hosRemainingMin: 660 }, load: null })
  assert.match(out, /Driving time left today: 11 hours\./)
  assert.doesNotMatch(out, /\d+h\b|\d+m\b/)
})

const promptFor = (load) => buildDriverSystemPrompt({
  driver: DRIVER, load, now: NOW,
  standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 },
})

// Kills: the driver volunteering hours, fuel, pay or IDs nobody asked
// about (ED01 "how r u" -> hours + fuel; ED10 "r u a bot" -> a data dump),
// or losing brevity while permitting an optional fitting personal reaction.
test('the driver answers first and stays brief while allowing a fitting personal reaction', () => {
  const p = promptFor(LOAD)
  assert.match(p, /Answer what was asked first, in one or two short sentences/)
  assert.match(p, /After the answer, a brief dry joke or friendly bit of banter is welcome when\s+your personality and the message invite it\. Most replies need none/)
  assert.match(p, /Do not volunteer hours, fuel, pay, truck number, load ID/)
  assert.doesNotMatch(p, /One to three sentences/)
})

// Kills: dropping the no-promise rule (ED02 "Let me look." with no load),
// or the plain "no load" answer.
test('the driver never promises to look or get back, and says plainly when she has no load', () => {
  const p = promptFor(null)
  assert.match(p, /never say "let me look", "let me check", "I will get back to you",\s+"give me a sec"/)
  assert.match(p, /If you have no load, say so plainly\./)
})

// Kills: the exactness rule demanding machine formats again.
test('the exactness rule asks for human wording, not machine format', () => {
  const p = promptFor(LOAD)
  assert.match(p, /"11 hours", never "11h 00m"/)
  assert.doesNotMatch(p, /do not round them/)
})

// Kills: a stance that makes her raise pay on a greeting or a bot joke
// (ED01, ED10 -- the quits stance dumped amount and days on "r u a bot").
test('every money stance that talks about pay does it in one line, when pay comes up', () => {
  for (const stage of ['asks', 'refuses', 'quits']) {
    const p = buildDriverSystemPrompt({
      driver: DRIVER, load: null, now: NOW,
      standing: { stage, unpaidCount: 1, owedUsd: 529, daysOverdue: 12 },
    })
    const block = p.slice(p.indexOf('MONEY:'), p.indexOf('HOW YOU TALK:'))
    assert.match(block, /one short line/, stage)
    assert.match(block, /(when work or pay comes up|only when pay comes up)/, stage)
    assert.match(block, /greeting|unrelated question/, stage)
    assert.doesNotMatch(p, /Bring it up early/, stage)
  }
})

// Kills: the prompt teaching Grace a flat "ha, sure" to "are you a bot" --
// read as a yes (ED10, 2026-10-17). She says no plainly instead.
test('asked if she is a bot she says no plainly, never "sure"', () => {
  const p = promptFor(LOAD)
  assert.doesNotMatch(p, /ha, sure/i)
  assert.match(p, /say no plainly/)
  assert.match(p, /Never "sure", "maybe"/)
})

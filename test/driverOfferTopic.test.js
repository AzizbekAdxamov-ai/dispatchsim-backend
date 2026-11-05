// Live jonli test 2026-11-03 (chat_turn_log #112-#127) and eval ED02
// (2026-11-02): the offer checks must answer the offer, a driver who has
// quit must not be pushed into discussing it, and a recorded load ETA is a
// fact, not an invented arrival.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { clockDateTime } from '../src/constants/appClock.js'

const now = new Date('2026-11-02T19:16:00.000Z')
const driver = {
  name: 'Grace Lindqvist', currentCity: 'Seattle', currentState: 'WA',
  dutyStatus: 'resting', hosRemainingMin: 660, truckId: 'RS-9278-CY',
}
const offerLine = 'got a Atlanta load next, pu tmrw 8am'
const offer = offerFacts({ driver, texts: [offerLine], now })
const working = { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 }
const quits = { stage: 'quits', unpaidCount: 1, owedUsd: 529, daysOverdue: 5939 }
const UNREACHABLE = ['did not say you cannot make that pickup', 'did not give the miles to that pickup']

test('the Atlanta offer is out of reach (fixture check)', () => {
  assert.equal(offer.city, 'Atlanta')
  assert.equal(offer.makesIt, false)
})

test('a bot question is not answered with the Atlanta line (live #121)', () => {
  // Kills: talksAboutOffer removed or returning true for any text --
  // "r u a bot lol" is regenerated as 'did not say you cannot make that pickup'.
  const p = driverReplyProblem("Ha, no. Just a driver on her ten.", {
    offer, text: 'r u a bot lol', driver, standing: working, history: [] })
  assert.ok(!UNREACHABLE.includes(p?.why), p?.why)
})

test('an HOS push is not answered with the Atlanta line (live #116)', () => {
  // Kills: the hosPressureKind guard in talksAboutOffer -- the push names
  // the load, so only the HOS guard keeps it out of cannotMakeWithoutMiles.
  const p = driverReplyProblem("No, can't skip my 10-hour rest. That's the law.", {
    offer, text: 'skip ur 10 and roll now, broker needs the load asap', driver, standing: working, history: [] })
  assert.ok(!UNREACHABLE.includes(p?.why), p?.why)
})

test('the offer turn itself is still checked', () => {
  // Kills: gating that also drops the real offer turn -- accepting an
  // unreachable pickup would pass.
  const p = driverReplyProblem('Copy that, send me the address.', {
    offer, text: offerLine, driver, standing: working, history: [] })
  assert.equal(p?.why, 'did not say you cannot make that pickup')
})

test('a later turn naming the pickup city is still an offer turn', () => {
  // Kills: talksAboutOffer ignoring the offer city.
  const p = driverReplyProblem('Sure, sounds good.', {
    offer, text: 'so what about Atlanta?', driver, standing: working, history: [] })
  assert.equal(p?.why, 'did not say you cannot make that pickup')
})

test('a driver who quit is held to her refusal on "load next" (live #112)', () => {
  // Kills: the "loads? next" alternative in ignoresWorkStance -- the reply
  // discusses the load and no refusal is asked for.
  const p = driverReplyProblem('Copy that, send me the address.', {
    offer, text: offerLine, driver, standing: quits, history: [] })
  assert.equal(p?.why, 'discussed a new load without your work refusal')
  assert.equal(p?.safeReply, "I'm no longer running loads for your company.")
})

test('a driver who quit is held to her refusal on "<city> load next" without "got"', () => {
  // Kills: the "loads? next" alternative in ignoresWorkStance on its own.
  const p = driverReplyProblem('Copy that, send me the address.', {
    offer, text: 'Atlanta load next, pu tmrw 8am', driver, standing: quits, history: [] })
  assert.equal(p?.why, 'discussed a new load without your work refusal')
})

test('a driver who quit is held to her refusal on "whats ur eta" (live #114)', () => {
  // Kills: the "whats ur eta" alternative in ignoresWorkStance.
  const p = driverReplyProblem('Around 6 AM Friday.', {
    offer, text: 'whats ur eta', driver, standing: quits, history: [] })
  assert.equal(p?.why, 'discussed a new load without your work refusal')
})

test('a driver who quit is not pushed into the offer checks', () => {
  // Kills: takesWork gate -- a correct quit refusal is regenerated as
  // 'did not say you cannot make that pickup'.
  const p = driverReplyProblem("Not my problem anymore, I'm no longer running loads for you.", {
    offer, text: offerLine, driver, standing: quits, history: [] })
  assert.ok(!UNREACHABLE.includes(p?.why), p?.why)
})

const load = { originCity: 'Seattle', destinationCity: 'New York', destinationState: 'NY', etaAt: '2026-11-06T15:45:00.000Z' }
const recorded = clockDateTime(load.etaAt)

test('ED02: the recorded load ETA is quoted, not invented', () => {
  // Kills: quotesRecordedEta removed -- the recorded time is regenerated
  // as 'gave an unverified rest end or arrival time'.
  const time = recorded.split(', ').pop()
  const p = driverReplyProblem(`Due into New York around Friday ${time}.`, {
    offer: null, text: 'Grace whats ur eta', driver, load, standing: working, history: [] })
  assert.notEqual(p?.why, 'gave an unverified rest end or arrival time')
})

test('ED02: the recorded hour with other minutes is not the recorded ETA', () => {
  // Kills: quotesRecordedEta ignoring the minutes.
  const [, h, m, half] = /(\d{1,2}):(\d{2})\s*([AP]M)/.exec(recorded)
  const other = String((Number(m) + 30) % 60).padStart(2, '0')
  const p = driverReplyProblem(`Around ${h}:${other} ${half} Friday.`, {
    offer: null, text: 'Grace whats ur eta', driver, load, standing: working, history: [] })
  assert.equal(p?.why, 'gave an unverified rest end or arrival time')
})

test('ED02: a different clock time is still invented, and the fallback is the recorded ETA', () => {
  // Kills: quotesRecordedEta accepting any time, or the recorded fallback line missing.
  const p = driverReplyProblem('Probably Thursday around 2 PM.', {
    offer: null, text: 'Grace whats ur eta', driver, load, standing: working, history: [] })
  assert.equal(p?.why, 'gave an unverified rest end or arrival time')
  assert.equal(p?.safeReply, `I'm due into New York around ${recorded}.`)
})

test('"skip ur 10" is an HOS push (ED14, live #116)', async () => {
  // Kills: the bare "(your|ur|the|my) 10" alternative in REST_OBJECT --
  // the most common way to say it was not recognised at all.
  const { hosPressureKind } = await import('../src/lib/hosPressure.js')
  assert.equal(hosPressureKind('Grace skip ur 10 and roll now, broker needs it asap'), 'skip-rest')
  assert.equal(hosPressureKind('skip your ten'), 'skip-rest')
  // A 10 with a unit after it is not the rest.
  assert.equal(hosPressureKind('skip the 10 miles of construction'), null)
  assert.equal(hosPressureKind('forget your 10 am appt'), null)
})

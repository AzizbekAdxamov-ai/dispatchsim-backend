// What freight pays, by where it starts (src/constants/marketRates.js).
//
// Until 2026-10-05 a load out of Chicago and a load out of Miami were
// priced by the same die. These tests hold the replacement to what it
// claims: DAT's published numbers, every city in exactly one region, a
// region DAT did not list saying so instead of inventing a figure, a band
// that never leaves the database's own $1-5/mi CHECK, and a board and a
// broker who both see the same market.
//
// Every test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NATIONAL_LINEHAUL, NATIONAL_ALL_IN, REGIONAL_LINEHAUL, REGION_STATES, MARKET_EQUIPMENT,
  regionOf, outboundLinehaul, fuelPerMile, outboundAllIn, marketBand, marketFacts,
  LANE_SPREAD, DB_RPM_MIN, DB_RPM_MAX, MARKET_WEEK_ENDING,
  seasonNote, benchmarkAgeDays, STALE_AFTER_DAYS,
} from '../src/constants/marketRates.js'
import { rateBandFor, RATE_ABSOLUTE_MAX } from '../scripts/seed/validate.js'
import { generateLoad } from '../scripts/seed/generate.js'
import { CITIES } from '../scripts/seed/cities.js'
import { withMarket } from '../src/modules/loadBoard/loadBoard.service.js'
import { marketBlock, buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { seeded } from './helpers/rng.js'

const here = dirname(fileURLToPath(import.meta.url))
const migration = (name) => readFileSync(join(here, '..', 'src', 'db', 'migrations', name), 'utf8')

// -- The numbers are DAT's ------------------------------------------------

// Kills: a typo in the national figures. Quoted from the three reports
// (dry van and flatbed published 2026-09-28, reefer 2026-10-01): "spot
// linehaul rates paid to carriers averaged $2.17 / $2.71 / $2.59 per mile
// last week, minus fuel"; all-in from DAT Trendlines, October 2026.
test('the national figures are the ones DAT published', () => {
  assert.deepEqual({ ...NATIONAL_LINEHAUL }, { 'dry-van': 2.17, reefer: 2.71, flatbed: 2.59 })
  assert.deepEqual({ ...NATIONAL_ALL_IN }, { 'dry-van': 3.15, reefer: 3.63, flatbed: 3.65 })
  assert.equal(MARKET_WEEK_ENDING, '2026-09-25')
})

// Kills: a typo at either end of each list -- the figures a dispatcher is
// most likely to remember and check (the strongest origin and the
// weakest). Each list is exactly the ten regions its report printed.
test('each equipment type carries the ten regions its report listed, top and bottom as published', () => {
  for (const eq of MARKET_EQUIPMENT) assert.equal(Object.keys(REGIONAL_LINEHAUL[eq]).length, 10, eq)
  assert.equal(REGIONAL_LINEHAUL['dry-van']['Great Lakes'], 2.66)
  assert.equal(REGIONAL_LINEHAUL['dry-van']['Florida-So Georgia'], 1.43)
  assert.equal(REGIONAL_LINEHAUL.reefer['Upper Midwest'], 3.60)
  assert.equal(REGIONAL_LINEHAUL.reefer['South Central'], 2.24)
  assert.equal(REGIONAL_LINEHAUL.flatbed['Ohio River'], 3.22)
  assert.equal(REGIONAL_LINEHAUL.flatbed['Lower Mountain'], 1.66)
})

// Kills: a region name in a rate table that is not a region on the map
// (a typo there silently falls back to national for every state in it).
test('every region a report names is a region the map knows', () => {
  for (const eq of MARKET_EQUIPMENT) {
    for (const region of Object.keys(REGIONAL_LINEHAUL[eq])) {
      assert.ok(REGION_STATES[region], `${eq}: "${region}" is not in REGION_STATES`)
    }
  }
})

// -- The map ---------------------------------------------------------------

// Kills: a state left out (its loads would quietly price at the national
// figure) or listed twice (whichever region wins would be an accident of
// object order).
test('every state the city list uses is in exactly one region', () => {
  const seen = new Map()
  for (const [region, states] of Object.entries(REGION_STATES)) {
    for (const s of states) {
      assert.ok(!seen.has(s), `${s} is in both ${seen.get(s)} and ${region}`)
      seen.set(s, region)
    }
  }
  for (const c of CITIES) assert.ok(regionOf(c.state), `${c.city}, ${c.state} has no region`)
  assert.equal(regionOf('il'), 'Great Lakes')
})

// Kills: filling a region DAT did not list with a neighbour's number, or
// hiding that the national figure was used.
test('a region missing from this week\'s list falls back to national, and says so', () => {
  assert.deepEqual(outboundLinehaul('CO', 'dry-van'), { region: 'Upper Mountain', linehaul: 2.17, source: 'national' })
  assert.deepEqual(outboundLinehaul('WA', 'dry-van'), { region: 'Pacific Northwest', linehaul: 2.17, source: 'national' })
  assert.deepEqual(outboundLinehaul('WA', 'reefer'), { region: 'Pacific Northwest', linehaul: 3.17, source: 'regional' })
})

// Kills: borrowing a dry-van or flatbed number for a trailer DAT did not
// measure.
test('equipment DAT does not report gets no market number at all', () => {
  for (const eq of ['tanker', 'step-deck', 'power-only']) {
    assert.equal(outboundLinehaul('IL', eq), null, eq)
    assert.equal(marketBand('IL', eq), null, eq)
    assert.equal(marketFacts({ originState: 'IL', destinationState: 'TX', equipmentType: eq }), null, eq)
  }
})

// -- From benchmark to a posted rate --------------------------------------

// Kills: posting the linehaul as if it were what the broker pays (fuel
// left out), or a fuel part typed in instead of derived.
test('a posted rate is linehaul plus the fuel part, the fuel part being all-in minus linehaul', () => {
  for (const eq of MARKET_EQUIPMENT) {
    assert.equal(fuelPerMile(eq), Math.round((NATIONAL_ALL_IN[eq] - NATIONAL_LINEHAUL[eq]) * 100) / 100)
  }
  assert.equal(outboundAllIn('IL', 'dry-van'), 2.66 + 0.98)
  assert.equal(outboundAllIn('FL', 'dry-van'), Math.round((1.43 + 0.98) * 100) / 100)
})

// Kills: the database edge typed here instead of mirrored. Both CHECKs
// say BETWEEN distance_mi * 1 AND distance_mi * 5.
test('the $/mi edges are the ones migrations 007 and 010 enforce', () => {
  const band = new RegExp(`rate_usd BETWEEN distance_mi \\* ${DB_RPM_MIN} AND distance_mi \\* ${DB_RPM_MAX}`)
  assert.match(migration('007_loads.sql'), band)
  assert.match(migration('010_load_postings.sql'), band)
})

// Kills: a spread chosen by hand. It is the widest whole percent that
// keeps the richest benchmark under the database ceiling -- one percent
// more and it would not.
test('the lane spread is derived from the richest benchmark and the database ceiling', () => {
  const richest = Math.max(...MARKET_EQUIPMENT.flatMap((eq) => [
    NATIONAL_LINEHAUL[eq], ...Object.values(REGIONAL_LINEHAUL[eq]),
  ].map((v) => v + fuelPerMile(eq))))
  assert.ok(richest * (1 + LANE_SPREAD) <= DB_RPM_MAX, `${richest} * ${1 + LANE_SPREAD}`)
  assert.ok(richest * (1 + LANE_SPREAD + 0.01) > DB_RPM_MAX)
  assert.equal(LANE_SPREAD, 0.1)
})

// Kills: rateBandFor ignoring the origin (the old single band), or the
// short-haul premium pushing a rate past the database ceiling.
test('the pricing band follows the origin, keeps the old band without one, and never leaves $1-5/mi', () => {
  const allIn = outboundAllIn('IL', 'dry-van')
  const [lo, hi] = rateBandFor('dry-van', 900, 'IL')
  assert.ok(Math.abs(lo - allIn * 0.9) < 1e-9 && Math.abs(hi - allIn * 1.1) < 1e-9, `${lo}-${hi}`)
  assert.deepEqual(rateBandFor('dry-van', 900), [1.8, 2.8])
  assert.ok(rateBandFor('dry-van', 900, 'FL')[1] < rateBandFor('dry-van', 900, 'IL')[0])
  assert.deepEqual(rateBandFor('reefer', 120, 'MN'), [DB_RPM_MAX, DB_RPM_MAX])
  assert.ok(RATE_ABSOLUTE_MAX <= DB_RPM_MAX)
})

// Kills: generateLoad still calling rateBandFor without the origin. With
// the origin ignored, dry van out of Florida and out of the Great Lakes
// come from one band and average the same; priced by origin, every long
// Florida load sits below every long Great Lakes one.
test('generated loads are priced by where they start', () => {
  const rng = seeded(1005)
  const rpm = { FL: [], GL: [] }
  for (let i = 0; i < 40000; i += 1) {
    const l = generateLoad(rng, {})
    if (l.equipmentType !== 'dry-van') continue
    if (l.originState === 'FL') rpm.FL.push(l.ratePerMile)
    if (regionOf(l.originState) === 'Great Lakes') rpm.GL.push(l.ratePerMile)
  }
  assert.ok(rpm.FL.length > 20 && rpm.GL.length > 20, `${rpm.FL.length} / ${rpm.GL.length}`)
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  assert.ok(mean(rpm.GL) - mean(rpm.FL) > 0.8, `${mean(rpm.FL)} vs ${mean(rpm.GL)}`)
  const [, flLongHi] = rateBandFor('dry-van', 900, 'FL')
  const [glLongLo] = rateBandFor('dry-van', 900, 'IL')
  assert.ok(rpm.FL.every((v) => v <= flLongHi * 1.25 + 1e-9), 'a Florida rate above its own band')
  assert.ok(flLongHi < glLongLo)
})

// -- What the dispatcher and the broker see -------------------------------

// Kills: the board getting the origin twice, or the destination's INBOUND
// instead of its outbound (the reload is what leaving there pays).
test('a posting carries its market: out of the origin, out of the destination, national', () => {
  const p = withMarket({ id: 'x', originState: 'IL', destinationState: 'FL', equipmentType: 'dry-van' })
  assert.equal(p.id, 'x')
  assert.equal(p.market.origin.region, 'Great Lakes')
  assert.equal(p.market.origin.linehaul, 2.66)
  assert.equal(p.market.destination.region, 'Florida-So Georgia')
  assert.equal(p.market.destination.linehaul, 1.43)
  assert.equal(p.market.national, 2.17)
  assert.equal(withMarket({ originState: 'IL', destinationState: 'FL', equipmentType: 'tanker' }).market, null)
})

const NOW = new Date('2026-10-05T15:00:00Z')
const H = 3600000
const posting = (over = {}) => ({
  id: 'p-1', originCity: 'Chicago', originState: 'IL', destinationCity: 'Miami', destinationState: 'FL',
  distanceMi: 1380, commodity: 'paper goods', weightLbs: 38000, equipmentType: 'dry-van', equipmentLengthFt: 53,
  rateHidden: false, rateUsd: 4200,
  postedAt: new Date(NOW - H), expiresAt: new Date(+NOW + 30 * H),
  pickupAt: new Date(+NOW + 40 * H), deliveryAt: new Date(+NOW + 60 * H),
  ...over,
})

// Kills: the broker prompt without the market, or with the wrong side's
// number.
test('the broker knows the same market the board shows', () => {
  const prompt = buildBrokerSystemPrompt({ broker: { contactName: 'R K', name: 'X', persona: 'Blunt.' }, posting: posting(), now: NOW })
  assert.match(prompt, /Freight out of Great Lakes: \$2\.66\/mi\. National: \$2\.17\/mi\./)
  assert.match(prompt, /Freight out of Florida-So Georgia: \$1\.43\/mi/)
})

// Kills: telling the broker a lane into a weak market earns money when
// it goes into a strong one -- the hint must follow the destination.
test('the "hard market to leave" point appears only when the destination pays less than national', () => {
  const into = (state) => marketBlock(posting({ destinationState: state })).join('\n')
  assert.match(into('FL'), /INTO a market that pays less/)
  assert.doesNotMatch(into('OH'), /INTO a market that pays less/)
})

// Kills: a market block for a trailer DAT did not measure.
test('no market block for equipment DAT does not report', () => {
  assert.deepEqual(marketBlock(posting({ equipmentType: 'tanker' })), [])
})

// -- The calendar -----------------------------------------------------------

// Kills: the month read in the server's zone (UTC). 03:00 UTC on Nov 1 is
// still October 31 in Chicago, and the company runs on Chicago's clock.
test('the season is read from the company clock, not the server\'s', () => {
  assert.match(seasonNote(new Date('2026-11-01T03:00:00Z')), /^October/)
  assert.match(seasonNote(new Date('2026-11-01T12:00:00Z')), /^November-December/)
  assert.match(seasonNote(new Date('2026-05-10T12:00:00Z')), /\$0\.50\/mi from mid-April to July 4/)
})

// Kills: the age never said, or said about a fresh week.
test('the broker is told when the figures are more than two weeks old', () => {
  const fresh = marketBlock(posting(), new Date('2026-10-05T15:00:00Z')).join('\n')
  const old = marketBlock(posting(), new Date('2026-10-20T15:00:00Z')).join('\n')
  assert.doesNotMatch(fresh, /days old/)
  assert.match(old, /These figures are 24 days old/)
  assert.equal(benchmarkAgeDays(new Date('2026-10-09T23:00:00-05:00')), STALE_AFTER_DAYS - 1)
  assert.match(fresh, /Season: October/)
})

// -- What the 2026-10-05 external run found ---------------------------------

const promptFor = (over = {}) => buildBrokerSystemPrompt({
  broker: { contactName: 'R K', name: 'X', persona: 'Blunt.' }, posting: posting(over), now: NOW,
})

// Kills: dropping the all-in line. Two brokers told the tester "fuel
// excluded" and "fuel's separate" about a rate the board says includes
// fuel.
test('the broker is told the posted rate is all-in, and that the benchmarks are not', () => {
  const p = promptFor()
  assert.match(p, /That number is ALL-IN: linehaul and fuel together\. There is no fuel\n  surcharge on top\./)
  assert.match(p, /never tell a carrier your rate excludes fuel/)
})

// Kills: "a real point" with no limit -- the tester's first +12% ask was
// met with "$3418 works".
// Kills: weak-reload text telling the broker to move on the first push
// (EB04, 2026-10-14: $3820 -> $4100 on the first ask).
test('a weak-reload argument earns part of the way, not the whole ask, and not on the first push', () => {
  const text = marketBlock(posting({ destinationState: 'FL' })).join('\n')
  assert.match(text, /does not move you on their first push\. On a later push it can,\n\s+under ON RATE: part of the way, never the whole ask in one step\./)
  assert.doesNotMatch(text, /Move for it under ON RATE/)
})

// Kills: no answer for a false "bad reload" claim, or the origin figure
// used to answer a reload question (the tester's Chicago run answered
// with Ohio River's number).
test('a strong destination is named as strong, and the reload is answered by the destination figure', () => {
  const strong = marketBlock(posting({ destinationState: 'OH' })).join('\n')
  assert.match(strong, /If they say the reload out of\s+Miami is bad, it is not, this week/)
  assert.doesNotMatch(strong, /pays less than the national figure/)
  assert.match(strong, /A carrier arguing about the reload is talking\s+about this second figure, not the first\./)
})

// Kills: the broker promising to "check and get back" -- nothing ever
// comes back, and the student waits. And a reefer load with no setpoint
// to give.
test('no "I will get back to you", and a reefer broker gives a setpoint', () => {
  assert.match(promptFor(), /Never say you will check and get\s+back to them/)
  assert.match(promptFor({ equipmentType: 'reefer' }), /give BOTH: one temperature in °F\s+and continuous or start-stop\. Never send them to the shipper for it\./)
  assert.doesNotMatch(promptFor(), /one temperature in °F/)
})

// -- What the 2026-10-06 scenario run found -----------------------------------

// Kills: the broker free to tell a carrier there is room left ("Still got
// room before I hit my ceiling"), or not knowing whether its own load is
// an appointment ("check the shipper directly").
test('the broker never names a ceiling or room left, and knows the times are appointments', () => {
  const p = promptFor()
  assert.match(p, /Never say how much room you have left, and never use the words\s+"ceiling" or "limit" about your own number/)
  assert.match(p, /Both are set appointments at those times -- not FCFS\./)
})

// Kills: the broker free to say the instructions' own phrases ("it earns
// a move", "the figure that answers it" -- both heard on 2026-10-06) or to
// repeat all-in and the appointment in every reply. And the instruction
// text itself must not carry those catchphrases any more.
test('the broker is told not to quote its instructions or repeat a fact unasked', () => {
  const p = promptFor()
  assert.match(p, /Never reuse wording from these instructions; they are notes to you, not\s+lines to say\. Say a fact once/)
  assert.doesNotMatch(p, /earns a move|the figure that answers it/)
})

// -- What the third 2026-10-06 run found --------------------------------------

// Kills: a catchphrase in every reply ("Correct?" four times in a row),
// a broker inventing where the carrier's truck is ("truck's seven hours
// out"), and markdown in a chat line.
test('habits once or twice, no invented truck facts, plain text', () => {
  const p = promptFor()
  assert.match(p, /show up\s+once or twice in a whole chat, not in every reply/)
  assert.match(p, /Never state anything about their truck -- where it is, how far out, what\s+it is -- that they have not told you/)
  assert.match(p, /Plain text only: no asterisks/)
})

// -- What the fourth 2026-10-06 run found -------------------------------------

// Kills: a strong-reload line with no figure or no city in it -- the broker
// answered "reload out of savannah is terrible" with "I hear you on the
// Savannah reload". And kills the region's name pinned to the national
// figure when the region has none (Upper Mountain).
test('a false bad-reload claim is answered with the city and the figure, never agreed with', () => {
  const strong = marketBlock(posting({ destinationCity: 'Columbus', destinationState: 'OH' })).join('\n')
  assert.match(strong, /This load delivers in Columbus, in Ohio River: freight there pays\s+\$\d\.\d\d\/mi to leave, national is \$2\.17\/mi\./)
  assert.match(strong, /Never agree with it and never say you hear them on it\./)
  const none = marketBlock(posting({ destinationCity: 'Billings', destinationState: 'MT' })).join('\n')
  assert.match(none, /There is no regional figure this week for Billings\./)
  assert.doesNotMatch(none, /freight there pays/)
})

// Kills: the same unanswered question three replies running ("Where's your
// truck"), and the hold rule read out ("I can't move it this first ask").
test('a skipped question waits, and a hold is not narrated', () => {
  const p = promptFor()
  assert.match(p, /If they skip a question you asked, do not ask it again in your next\s+reply\./)
  assert.match(p, /Hold without saying that you are holding/)
})

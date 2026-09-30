// Building the market without asking anyone.
//
// Every value here is derived from a closed list, a real distribution, or
// a rule the code already owned. Nothing is requested over a network, so
// nothing here can be rate-limited, time out, return prose instead of
// JSON, invent a city, or be dropped by a validator.
//
// WHAT THIS REPLACED, and why it is not a downgrade:
//
//   A load asked the model for nine fields. Four were "pick from this list
//   I am pasting into the prompt" (two cities, broker, equipment). Two were
//   numbers the code then CLAMPED into a band it computed itself --
//   validate.js's rateBandFor() already knows that a short-haul reefer
//   prices above a long dry-van, and it overwrote the model's guess every
//   time. One was the origin/destination pair, which had to come back
//   verbatim from a list or be dropped. That leaves `commodity`: one string,
//   for twenty-four network calls a refresh.
//
//   So the strings live in vocabulary.js and the numbers are derived. The
//   model can still author that vocabulary -- it is a file, and a model can
//   write a file -- but it writes it once instead of on every refresh.
//
// DETERMINISM. Every function takes an `rng`, so a seeded run is
// reproducible and a test can assert a distribution rather than hope.

import { CITIES, findCity, roadMiles } from './cities.js'
import { BROKERS, ENDORSEMENTS } from './schemas.js'
import { EQUIPMENT_KEYS } from '../../src/constants/equipment.js'
import { rateBandFor, clampWeightLbs } from './validate.js'
import {
  COMMODITIES, FIRST_NAMES, LAST_NAMES,
  TRUCK_MAKES, TRUCK_MODELS, SELLERS, SERVICE_NOTES,
} from './vocabulary.js'
import { EQUIPMENT_MIX, SERVICE_NOTE_DRAW } from './marketTargets.js'

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

export function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

export function between(rng, lo, hi) {
  return lo + rng() * (hi - lo)
}

export function intBetween(rng, lo, hi) {
  return Math.floor(between(rng, lo, hi + 1))
}

// A weighted pick, given [value, weight] pairs. Used wherever a uniform
// draw would be a lie: most drivers are class A, most trucks are dry-van.
export function weighted(rng, pairs) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0)
  let roll = rng() * total
  for (const [value, weight] of pairs) {
    roll -= weight
    if (roll < 0) return value
  }
  return pairs[pairs.length - 1][0]
}

// Two draws averaged: a triangular distribution centred on the middle of
// the range. Real fleets are not uniform -- most trucks are middle-aged,
// most drivers have middling experience -- and a flat draw makes a market
// where every extreme is as common as the ordinary case.
export function centered(rng, lo, hi) {
  return lo + ((rng() + rng()) / 2) * (hi - lo)
}

// ---------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------

// The mix on a real board. Dry van is most of it; power-only is a niche.
export { EQUIPMENT_MIX, SERVICE_NOTE_DRAW } from './marketTargets.js'

// What each trailer actually carries, in pounds. A reefer of lettuce is
// light and cubes out; a flatbed of steel is heavy and weighs out. Asking
// a model for "weightLbs between 1000 and 45000" produced neither.
const WEIGHT_BAND = Object.freeze({
  'dry-van': [8000, 42000],
  reefer: [14000, 43000],
  flatbed: [20000, 45000],
  'step-deck': [22000, 45000],
  tanker: [30000, 45000],
  'power-only': [12000, 44000],
})

const MIN_DISTANCE_MI = 120
const MAX_DISTANCE_MI = 2600

// Every city pair within the usable distance band, computed once.
//
// Precomputed rather than sampled-and-retried: with ~150 cities there
// are tens of thousands of pairs, and drawing at random until one lands in
// range would loop unpredictably on a sparse map. This also makes the true lane
// count knowable, which is what makes "how likely is a repeat" answerable.
function buildLanes() {
  const lanes = []
  for (let i = 0; i < CITIES.length; i += 1) {
    for (let j = 0; j < CITIES.length; j += 1) {
      if (i === j) continue
      const distanceMi = roadMiles(CITIES[i], CITIES[j])
      if (distanceMi < MIN_DISTANCE_MI || distanceMi > MAX_DISTANCE_MI) continue
      lanes.push({ origin: CITIES[i], destination: CITIES[j], distanceMi })
    }
  }
  return lanes
}

export const LANES = Object.freeze(buildLanes())

// How much more often a broker you have hauled for posts to your board.
//
// Freight is a relationship business. A broker who has moved three loads
// with you has your MC on their list and calls you first; a broker you
// have never worked with is still out there, just quieter. Uniform
// selection across twelve brokers made every name equally strange every
// day, which is the one thing a real board is not.
//
// Base weight 1 for everyone, so a new broker never disappears -- the
// student must still be able to meet someone new, and a market that only
// shows the people you already know teaches nothing about checking a
// broker's credit. Capped at LOYALTY_MAX loads so one heavily-worked
// broker cannot take over the board.
export const LOYALTY_BONUS_PER_LOAD = 0.5
export const LOYALTY_MAX_LOADS = 4

export function brokerWeights(history) {
  return BROKERS.map((name) => {
    const worked = Math.min(history?.get(name) ?? 0, LOYALTY_MAX_LOADS)
    return [name, 1 + worked * LOYALTY_BONUS_PER_LOAD]
  })
}

// One load, complete and already valid.
//
// `avoid` is a Set of "Origin, ST -> Destination, ST" keys the caller has
// already used. Honoured on a best-effort basis over a bounded number of
// draws: with thousands of lanes a collision is rare, and looping until
// the set is exhausted would hang once the caller has used them all.
// `brokerHistory` is a Map of broker name -> how many loads this company
// has already hauled for them. Optional: with none, every broker is
// equally likely, which is the right behaviour on a brand new account.
export function generateLoad(rng, { avoid, brokerHistory, hiddenRateShare = 0 } = {}) {
  let lane = pick(rng, LANES)
  if (avoid) {
    for (let tries = 0; tries < 12; tries += 1) {
      const key = `${lane.origin.city}, ${lane.origin.state} -> ${lane.destination.city}, ${lane.destination.state}`
      if (!avoid.has(key)) break
      lane = pick(rng, LANES)
    }
  }

  const equipmentType = weighted(rng, EQUIPMENT_MIX)
  const [wLo, wHi] = WEIGHT_BAND[equipmentType]
  // The band is the SAME function validate.js uses, so a generated rate is
  // inside the band by construction and the clamp downstream is a no-op
  // rather than a silent correction.
  const [rLo, rHi] = rateBandFor(equipmentType, lane.distanceMi)

  return {
    originCity: lane.origin.city,
    originState: lane.origin.state,
    destinationCity: lane.destination.city,
    destinationState: lane.destination.state,
    broker: weighted(rng, brokerWeights(brokerHistory)),
    commodity: pick(rng, COMMODITIES[equipmentType]),
    equipmentType,
    weightLbs: clampWeightLbs(Math.round(centered(rng, wLo, wHi) / 100) * 100),
    // Two decimals, like a rate anyone would quote.
    ratePerMile: Math.round(centered(rng, rLo, rHi) * 100) / 100,
    // "Call for rate". The number above is still what the load is worth
    // and still what the broker negotiates from -- the board just does not
    // print it. A student cannot sort their way past this one; they have
    // to open the chat and ask.
    rateHidden: rng() < hiddenRateShare,
  }
}

// ---------------------------------------------------------------------
// Applicants
// ---------------------------------------------------------------------

// Most applicants are ordinary. The tail is what makes hiring a decision:
// a driver with four violations is cheap to hire and expensive to keep.
const EXPERIENCE_MIX = Object.freeze([
  [[0, 2], 18], [[2, 6], 34], [[6, 12], 28], [[12, 25], 16], [[25, 40], 4],
])
const VIOLATION_MIX = Object.freeze([[0, 62], [1, 22], [2, 10], [3, 4], [4, 2]])
const ACCIDENT_MIX = Object.freeze([[0, 84], [1, 12], [2, 3], [3, 1]])
const GAP_MIX = Object.freeze([[[0, 1], 70], [[1, 4], 18], [[4, 12], 9], [[12, 36], 3]])

export function generateApplicant(rng, { index = 0 } = {}) {
  const home = pick(rng, CITIES)
  const [expLo, expHi] = weighted(rng, EXPERIENCE_MIX)
  const yearsExperience = intBetween(rng, expLo, expHi)

  // Endorsements follow experience: a tanker endorsement is something a
  // driver picks up after a few years, not on day one.
  const endorsements = []
  for (const [endorsement, chanceAt10Years] of [['hazmat', 0.30], ['tanker', 0.22], ['doubles', 0.18]]) {
    const chance = chanceAt10Years * Math.min(1, yearsExperience / 10)
    if (rng() < chance) endorsements.push(endorsement)
  }

  const desiredEquipment = weighted(rng, EQUIPMENT_MIX)
  const desiredPayModel = weighted(rng, [['percent', 55], ['permile', 45]])

  // Experience buys a better rate, and the bands are the ones the drivers
  // table allows (drivers_pay_percent 1000-5000 bp, drivers_pay_cents
  // 30-120). A number outside those is a row the database refuses.
  const seasoning = Math.min(1, yearsExperience / 20)
  const desiredPayValue = desiredPayModel === 'percent'
    ? Math.round(between(rng, 2200 + seasoning * 400, 2800 + seasoning * 700) / 50) * 50
    : Math.round(between(rng, 45 + seasoning * 12, 62 + seasoning * 20))

  const first = pick(rng, FIRST_NAMES)
  const last = pick(rng, LAST_NAMES)

  return {
    fullName: `${first} ${last}`,
    // Built, not requested. An address the model invented had to be
    // repaired anyway -- lower-cased, stripped of illegal characters, and
    // given a dot in the domain -- before applicants_email_fmt would take
    // it. `index` keeps a batch unique before the row id is even known.
    email: `${first}.${last}${index}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com',
    phone: `(${intBetween(rng, 201, 989)}) ${intBetween(rng, 200, 999)}-${String(intBetween(rng, 0, 9999)).padStart(4, '0')}`,
    cdlClass: weighted(rng, [['A', 92], ['B', 8]]),
    cdlState: home.state,
    yearsExperience,
    homeBaseCity: home.city,
    homeBaseState: home.state,
    endorsements,
    desiredEquipment,
    mvrViolations: weighted(rng, VIOLATION_MIX),
    preventableAccidents: weighted(rng, ACCIDENT_MIX),
    employmentGapMonths: (() => {
      const [lo, hi] = weighted(rng, GAP_MIX)
      return intBetween(rng, lo, hi)
    })(),
    desiredPayModel,
    desiredPayValue,
  }
}

// ---------------------------------------------------------------------
// Truck listings
// ---------------------------------------------------------------------

const LISTING_YEAR_MIN = 2015
const LISTING_YEAR_MAX = 2025
// Miles a long-haul truck covers in a year. Used to derive an odometer
// from age instead of asking for both and getting a 2024 truck with
// 900,000 miles on it.
const MILES_PER_YEAR = [85000, 130000]

export function generateTruckListing(rng, { now = new Date() } = {}) {
  const year = Math.round(centered(rng, LISTING_YEAR_MIN, LISTING_YEAR_MAX))
  const make = pick(rng, TRUCK_MAKES)
  const age = Math.max(0.5, now.getUTCFullYear() - year)
  const odometerMi = Math.round(age * between(rng, MILES_PER_YEAR[0], MILES_PER_YEAR[1]) / 1000) * 1000

  // Tyres wear with miles since the last set, not with the truck's age.
  // Drives wear faster than steers, which is why they are separate columns.
  const sinceTires = between(rng, 0, 120000)
  const tireRearPct = Math.max(15, Math.round(100 - (sinceTires / 120000) * 80))
  const tireFrontPct = Math.max(20, Math.min(100, tireRearPct + intBetween(rng, 5, 25)))

  const noteCount = intBetween(rng, SERVICE_NOTE_DRAW[0], SERVICE_NOTE_DRAW[1])
  const notes = []
  while (notes.length < noteCount) {
    const note = pick(rng, SERVICE_NOTES)
    if (!notes.includes(note)) notes.push(note)
  }

  return {
    make,
    model: pick(rng, TRUCK_MODELS[make]),
    year,
    odometerMi: Math.min(2000000, odometerMi),
    trailerType: weighted(rng, EQUIPMENT_MIX),
    tireFrontPct,
    tireRearPct,
    // No .slice() here any more. It used to be `.slice(0, 200)`, to keep
    // the join inside what schemas.js accepts -- a silent cut, mid-word,
    // on a sentence a student reads off a listing.
    //
    // vocabularySchema.js now derives the per-note limit FROM that 200 and
    // the draw count, so the longest possible join is 199 characters and
    // the cut can never be reached. test/vocabulary.test.js checks that
    // arithmetic against the schema, so a change to either number fails
    // there instead of quietly truncating here.
    serviceNotes: notes.join('. '),
    seller: pick(rng, SELLERS),
  }
}

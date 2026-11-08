// Turns validated AI suggestions (already passed through validate*Item in
// validate.js) into complete row objects for every seeded table, and
// renders them to SQL insert text via render.js.
//
// Every piece of randomness in this file comes from one seeded PRNG
// (mulberry32) so a given --seed always produces byte-identical output --
// Math.random()/Date.now() are never used anywhere below.
import { CITIES, findCity, roadMiles } from './cities.js'
import { SERVICES } from './services.js'
import { ANCHOR_LOADS, ANCHOR_DRIVERS } from './anchors.js'
import { renderInsert, jsonb } from './render.js'
import { buildPostingRows } from './postings.js'
import { buildTruckRows } from './trucks.js'
import { BREAK_MINUTES, DRIVING_LIMIT_HOURS, DUTY_WINDOW_HOURS, REQUIRED_REST_HOURS } from '../../src/constants/hosClock.js'
import { REAL_MS_PER_SIM_DAY } from '../../src/constants/simClock.js'

// Fixed point in time every generated timestamp is computed relative to.
// Never Date.now() -- a run's output must not depend on when it happened
// to be executed, only on --seed.
export const REFERENCE_NOW = new Date('2026-08-28T14:00:00.000Z')

// Standard mulberry32: a small, fast, deterministic PRNG. Given the same
// seed it produces the same sequence of floats in [0, 1) forever, on any
// machine -- which is the only thing that makes a two-run md5sum
// comparison meaningful.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------
// Small deterministic helpers -- every one of these takes `rng` and never
// touches Math.random.
// ---------------------------------------------------------------------

function randFloat(rng, min, max) {
  return min + rng() * (max - min)
}

function randInt(rng, min, max) {
  return Math.floor(randFloat(rng, min, max + 1))
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

// Fisher-Yates using the seeded rng, so shuffling is as reproducible as
// everything else here.
function shuffled(rng, arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

function weightedPick(rng, pairs) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0)
  let r = rng() * total
  for (const [value, w] of pairs) {
    if (r < w) return value
    r -= w
  }
  return pairs[pairs.length - 1][0]
}

function addHours(date, h) {
  return new Date(date.getTime() + h * 3600000)
}

function hoursBetween(a, b) {
  return (b.getTime() - a.getTime()) / 3600000
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

// One SIM day in real milliseconds. DQ document dates are written as
// sim-calendar moments: the qualification reader times them in sim
// days, so a real-calendar offset reads as hundreds of sim days stale
// (found live, 2026-09-25).
function simDayMs(days) {
  return days * REAL_MS_PER_SIM_DAY
}

function randomCity(rng) {
  return pick(rng, CITIES)
}

// Convenience wrapper — returns "City, ST" string. Preserved so
// buildTruckRow can use it at the exact same rng-draw position as the
// original code (after odometer_mi, before tire_front_pct).
function randomCityLabel(rng) {
  const c = randomCity(rng)
  return `${c.city}, ${c.state}`
}

// ---------------------------------------------------------------------
// Id / identifier generators
// ---------------------------------------------------------------------

const PLATE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function makePlate(rng, used) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const l1 = PLATE_LETTERS[Math.floor(rng() * PLATE_LETTERS.length)]
    const l2 = PLATE_LETTERS[Math.floor(rng() * PLATE_LETTERS.length)]
    const digits = String(randInt(rng, 0, 9999)).padStart(4, '0')
    const l3 = PLATE_LETTERS[Math.floor(rng() * PLATE_LETTERS.length)]
    const l4 = PLATE_LETTERS[Math.floor(rng() * PLATE_LETTERS.length)]
    const plate = `${l1}${l2}-${digits}-${l3}${l4}`
    if (!used.has(plate)) {
      used.add(plate)
      return plate
    }
  }
  throw new Error('could not generate a unique truck plate after 1000 attempts')
}

function makeCdlNumber(rng, used) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const num = `CDL${randInt(rng, 10000000, 99999999)}`
    if (!used.has(num)) {
      used.add(num)
      return num
    }
  }
  throw new Error('could not generate a unique CDL number after 1000 attempts')
}

function uniqueEmail(email, used) {
  let candidate = email
  let n = 2
  while (used.has(candidate)) {
    const [local, domain] = email.split('@')
    candidate = `${local}+${n}@${domain}`
    n += 1
  }
  used.add(candidate)
  return candidate
}

// ---------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------

// equipment_length_ft must be one of (28,42,45,48,53) per loads_equip_length.
// Each equipment type gets a plausible subset of that closed set.
export const EQUIP_LENGTHS = {
  'dry-van': [48, 53],
  reefer: [48, 53],
  flatbed: [45, 48, 53],
  'step-deck': [45, 48],
  tanker: [42, 45],
  'power-only': [53],
}

const PAYMENT_TERMS_WEIGHTS = [
  ['net30', 0.6],
  ['net15', 0.25],
  ['quickpay', 0.15],
]
const TERMS_DAYS = { net30: 30, net15: 15, quickpay: 2 }

// Kept deliberately generic (no invented specifics) so nothing here can
// collide with the project's banned-word rule.
const ACCESSORIAL_LABELS = ['Detention 2h', 'Lumper fee', 'Layover', 'Fuel surcharge adjustment', 'TONU']

// Reverse-fit ranges for the fixed-status anchor loads: each range keeps
// statusFromSlack()'s output pinned to the anchor's prescribed status
// with margin either side of the ontime/warn/crit boundaries, so the
// exact same derivation the AI loads use also produces the anchor's own
// status, instead of the status being asserted independently of time.
const ANCHOR_SLACK_RANGES = {
  ontime: [3, 10],
  warn: [-3.5, 1.5],
  crit: [-20, -4.5],
}

const SERVICE_BY_NAME = new Map(SERVICES.map((s) => [s.name, s]))

// ---------------------------------------------------------------------
// Timestamp construction
// ---------------------------------------------------------------------

// Fastest plausible transit uses a 58mph average (min hours), slowest a
// 42mph average plus a 12h rest period per estimated driving day (max
// hours) -- a one-day 400mi run and a three-day 1400mi run both get a
// realistic window instead of one flat multiplier.
export function transitBand(distanceMi) {
  const days = Math.max(1, Math.ceil(distanceMi / 500))
  return { minH: distanceMi / 58 + 2, maxH: distanceMi / 42 + 12 * days }
}

// The SHORTEST transit a legal schedule can produce, 49 CFR 395.3:
//
//   (a)(2) 14-hour window after 10 consecutive hours off (a)(1), of
//          which at most 11 hours may be driving (a)(3), with a 30-minute
//          break (a)(3)(ii) due after 8 cumulative hours. One duty day
//          therefore moves 11 hours of driving and 30 minutes of on-duty
//          break, then 10 off -- a 24h cycle (or 24.5 where the break is
//          additional) moving at most 11 hours of road time.
//
// DRIVING_LIMIT_HOURS / DUTY_WINDOW_HOURS / BREAK_MINUTES are the same
// constants the live planner (facilities/stopPlan.js via hosClock.js)
// enforces; deriving the floor from them is what makes a seeded window
// and a planned run agree rather than two opinions about the law.
// (Sleeper-berth splits can squeeze more driving into a window, but not
// more driving into a DAY -- 11 hours is the daily driving cap regardless
// of how the rest is split, so the floor stands without modelling it.)
// The fastest legal schedule drives the clock's daily cap every day, so
// the binding caps are the driving limit and the window: 14h of window
// minus the 30-minute break could hold 13.5h of road time, but the 11h
// driving cap is tighter -- it binds.
const DRIVING_SPEED_MPH = 55 // long-haul planning speed, the same average the band's fast end assumes (58/42 across duty days)
const MAX_DRIVE_HOURS_PER_DAY = Math.min(DRIVING_LIMIT_HOURS, DUTY_WINDOW_HOURS - BREAK_MINUTES / 60) // 11
const MILES_PER_LEGAL_DAY = MAX_DRIVE_HOURS_PER_DAY * DRIVING_SPEED_MPH // 605 mi

export function legalTransitFloorHours(distanceMi) {
  const drivingH = distanceMi / DRIVING_SPEED_MPH
  const days = Math.max(1, Math.ceil(distanceMi / MILES_PER_LEGAL_DAY))
  // The whole run's driving, one 30-minute break made due inside each
  // duty day (the 8-hour rule), and the ten-hour off-duty reset between
  // consecutive duty days. Nothing is split per day because the fastest
  // legal schedule just adds the per-day constants; the window cannot
  // bind (a day's share of driving plus its break never exceeds 11.5h).
  return drivingH + days * (BREAK_MINUTES / 60) + (days - 1) * REQUIRED_REST_HOURS
}

// The transit a posting advertises: a uniform draw inside transitBand's
// window, floored at legalTransitFloorHours. The floor binds on multi-day
// lanes -- hand-computed: at 800mi the band min promises 15.8h against a
// legal minimum of 25.5h (two duty days + the reset); at 1200mi 22.7h
// against 32.8h. Sub-day lanes are untouched: their band min is already
// slower than the legal floor, and the board's short-haul spread keeps
// its shape.
export function drawTransitHours(rng, distanceMi) {
  const { minH, maxH } = transitBand(distanceMi)
  return Math.max(legalTransitFloorHours(distanceMi), minH + rng() * (maxH - minH))
}

// slack = how many hours before the promised delivery_at the load's ETA
// sits. Comfortably early -> ontime, a little behind -> warn, well past
// the promise -> crit. This is the single source of truth for in-transit
// status -- both AI loads and (via a pinned slack range) anchor loads run
// through it, so status is always a function of the timestamps.
function statusFromSlack(slackH) {
  if (slackH >= 2) return 'ontime'
  if (slackH >= -4) return 'warn'
  return 'crit'
}

// A load that has already been picked up and is somewhere en route right
// now (status in ontime/warn/crit). `forcedSlackRange`, when given, pins
// the random slack draw into a sub-range that only ever resolves to one
// status -- used to reverse-fit an anchor's already-decided status.
function buildInTransitTimestamps(rng, distanceMi, forcedSlackRange) {
  const pickupAt = addHours(REFERENCE_NOW, -randFloat(rng, 6, 60))
  const deliveryAt = addHours(pickupAt, drawTransitHours(rng, distanceMi))
  const [slackMin, slackMax] = forcedSlackRange || [-18, 12]
  const slackH = randFloat(rng, slackMin, slackMax)
  const etaAt = addHours(deliveryAt, -slackH)
  const status = statusFromSlack(slackH)
  const bookedAt = addHours(pickupAt, -randFloat(rng, 12, 72))
  const dispatchedAt = addHours(bookedAt, randFloat(rng, 1, Math.max(2, hoursBetween(bookedAt, pickupAt) - 1)))
  return { bookedAt, pickupAt, deliveryAt, dispatchedAt, etaAt, deliveredAt: null, status }
}

// A load that has already been delivered. `deliveredDaysAgo` is decided
// by the caller (it drives which AR-aging bucket the load's invoice
// falls into), not picked here.
function buildDoneTimestamps(rng, distanceMi, deliveredDaysAgo) {
  const deliveredAt = addHours(REFERENCE_NOW, -(deliveredDaysAgo * 24 + randFloat(rng, 0, 20)))
  const actualTransitH = drawTransitHours(rng, distanceMi)
  const pickupAt = addHours(deliveredAt, -actualTransitH)
  const promisedTransitH = drawTransitHours(rng, distanceMi)
  const deliveryAt = addHours(pickupAt, promisedTransitH)
  const bookedAt = addHours(pickupAt, -randFloat(rng, 12, 96))
  const dispatchedAt = addHours(bookedAt, randFloat(rng, 1, Math.max(2, hoursBetween(bookedAt, pickupAt) - 1)))
  return { bookedAt, pickupAt, deliveryAt, dispatchedAt, etaAt: null, deliveredAt, status: 'done' }
}

// A load that's booked but not yet picked up (status='neutral' --
// dispatched_at/driver/truck stay NULL per loads_pending_clean).
//
// bookedAt was once returned undeclared here -- a ReferenceError that
// only fired on the neutral path, so every seed run that rolled an 8%
// neutral load died at build. A neutral load IS booked: it has a real
// booking timestamp, it just has not been dispatched yet (that column
// stays NULL). Same draw shape as the other two builders.
function buildNeutralTimestamps(rng, distanceMi) {
  const pickupAt = addHours(REFERENCE_NOW, randFloat(rng, 6, 140))
  const deliveryAt = addHours(pickupAt, drawTransitHours(rng, distanceMi))
  const bookedAt = addHours(pickupAt, -randFloat(rng, 12, 96))
  return { bookedAt, pickupAt, deliveryAt, dispatchedAt: null, etaAt: null, deliveredAt: null, status: 'neutral' }
}

// Builds a done load's timestamps AND decides its invoice: which of the
// three AR-aging buckets (paid ~55% / open ~25% / overdue ~20%) it lands
// in is rolled first, and `deliveredDaysAgo` is then chosen so the
// resulting age relative to `paymentTerms` actually produces that bucket
// -- an "open" invoice needs a recent delivery, an "overdue" one needs a
// delivery older than its own payment terms.
function buildDoneLoad(rng, distanceMi, paymentTerms) {
  const termsDays = TERMS_DAYS[paymentTerms]
  const bucketRoll = rng()
  const bucket = bucketRoll < 0.55 ? 'paid' : bucketRoll < 0.8 ? 'open' : 'overdue'

  let deliveredDaysAgo
  if (bucket === 'paid') {
    deliveredDaysAgo = randInt(rng, 1, 75)
  } else if (bucket === 'open') {
    deliveredDaysAgo = randInt(rng, 1, Math.max(1, termsDays - 2))
  } else {
    deliveredDaysAgo = randInt(rng, Math.min(74, termsDays + 2), 75)
  }

  const timestamps = buildDoneTimestamps(rng, distanceMi, deliveredDaysAgo)

  let invoicePaidAt = null
  if (bucket === 'paid') {
    const availableH = hoursBetween(timestamps.deliveredAt, REFERENCE_NOW)
    const wantSpan = Math.max(24, termsDays * 24 * 1.1)
    const span = Math.max(7, Math.min(availableH, wantSpan))
    invoicePaidAt = addHours(timestamps.deliveredAt, randFloat(rng, 6, span))
  }

  return { timestamps, invoicePaidAt, bucket }
}

function maybeAccessorials(rng) {
  if (rng() < 0.12) {
    return jsonb([{ label: pick(rng, ACCESSORIAL_LABELS), amountUsd: randInt(rng, 50, 300) }])
  }
  return jsonb([])
}

// ---------------------------------------------------------------------
// Row builders -- one function per table, each returning a plain object
// keyed by the exact DB column name.
// ---------------------------------------------------------------------

const DUTY_STATUSES_BUSY = ['driving', 'on-duty']
const DUTY_STATUSES_FREE = ['resting', 'off']

function buildDriverRow({ rng, id, item, hasCurrentTruck, dutyOverride, usedEmails, usedCdlNumbers }) {
  const email = uniqueEmail(item.email.toLowerCase(), usedEmails)
  const cdlNumber = makeCdlNumber(rng, usedCdlNumbers)
  const dutyStatus = dutyOverride || pick(rng, hasCurrentTruck ? DUTY_STATUSES_BUSY : DUTY_STATUSES_FREE)
  const hosRemainingMin = dutyStatus === 'off' ? null : randInt(rng, 60, 660)
  const hoursTodayMin = randInt(rng, 0, 660)
  const hoursWeekMin = randInt(rng, hoursTodayMin, 4200)
  const payModel = pick(rng, ['percent', 'permile'])
  const payPercentBp = payModel === 'percent' ? randInt(rng, 1800, 3200) : null
  const payPerMileCents = payModel === 'permile' ? randInt(rng, 45, 85) : null
  // The license rides drivers.license_expires_on (005) -- now
  // timestamptz (043), same sim-calendar rule as the DQ dates: the
  // reader times it in sim days, so a real-calendar date would read as
  // hundreds of sim days stale.
  const licenseExpiresOn = new Date(REFERENCE_NOW.getTime() + simDayMs(randInt(rng, 180, 1400))).toISOString()
  const currentLocation =
    dutyStatus === 'off'
      ? `${item.homeBaseCity}, ${item.homeBaseState} yard`
      : `${item.homeBaseCity}, ${item.homeBaseState} area`
  // Derive structured location from home base — zero rng calls consumed,
  // so the rng stream stays identical to the pre-2a baseline.
  const homeCity = findCity(item.homeBaseCity, item.homeBaseState)

  return {
    id,
    name: item.fullName,
    email,
    phone: item.phone,
    cdl_class: item.cdlClass || 'A',
    cdl_number: cdlNumber,
    license_expires_on: licenseExpiresOn,
    home_base_city: item.homeBaseCity,
    home_base_state: item.homeBaseState,
    current_location: currentLocation,
    duty_status: dutyStatus,
    hos_remaining_min: hosRemainingMin,
    hours_today_min: hoursTodayMin,
    hours_week_min: hoursWeekMin,
    total_miles: randInt(rng, 40000, 520000),
    safety_rating: randInt(rng, 68, 100),
    broker_rating_x10: randInt(rng, 30, 50),
    pay_model: payModel,
    pay_percent_bp: payPercentBp,
    pay_per_mile_cents: payPerMileCents,
    current_city: item.homeBaseCity,
    current_state: item.homeBaseState,
    current_lat: homeCity ? homeCity.lat : null,
    current_lon: homeCity ? homeCity.lon : null,
  }
}

// 4 of 6 equipment types deliberately covered; step-deck and power-only
// are left uncovered so the "no matching equipment" warning fires for real.
const COVERED_TYPES = ['dry-van', 'reefer', 'flatbed', 'tanker']

function buildTruckRow({ rng, id, item, index, status, driverId }) {
  const fuelCapacityGal = randInt(rng, 150, 300)
  const fuelPct = status === 'maintenance' ? randInt(rng, 5, 40) : randInt(rng, 15, 100)
  const fuelGallons = Math.round(fuelCapacityGal * (fuelPct / 100))
  const hasFuelLog = status !== 'maintenance' || rng() < 0.5
  const lastFueledAt = hasFuelLog ? addHours(REFERENCE_NOW, -randFloat(rng, 2, 240)) : null
  const lastFueledLocation = hasFuelLog ? randomCityLabel(rng) : null
  // trailer_type from truck index — no rng consumed, flow is untouched
  const trailerType = COVERED_TYPES[index % COVERED_TYPES.length]

  return {
    id,
    make: item.make,
    model: item.model,
    year: item.year,
    odometer_mi: randInt(rng, 20000, 640000),
    status,
    driver_id: driverId,
    current_location: randomCityLabel(rng),
    fuel_pct: fuelPct,
    fuel_gallons: fuelGallons,
    fuel_capacity_gal: fuelCapacityGal,
    last_fueled_at: lastFueledAt,
    last_fueled_location: lastFueledLocation,
    tire_front_pct: randInt(rng, 15, 100),
    tire_rear_pct: randInt(rng, 15, 100),
    trailer_type: trailerType,
  }
}

function buildLoadRow({ id, item, driverId, truckId, timestamps, paymentTerms, invoicePaidAt, rng }) {
  const lowerBound = Math.max(100, item.distanceMi)
  const upperBound = Math.min(20000, item.distanceMi * 5)
  const rawRate = Math.round(item.distanceMi * item.ratePerMile)
  const rateUsd = Math.min(upperBound, Math.max(lowerBound, rawRate))

  return {
    id,
    origin_city: item.originCity,
    origin_state: item.originState,
    destination_city: item.destinationCity,
    destination_state: item.destinationState,
    broker: item.broker,
    commodity: item.commodity,
    rate_usd: rateUsd,
    distance_mi: item.distanceMi,
    weight_lbs: item.weightLbs,
    equipment_type: item.equipmentType,
    equipment_length_ft: pick(rng, EQUIP_LENGTHS[item.equipmentType]),
    status: timestamps.status,
    driver_id: driverId,
    truck_id: truckId,
    booked_at: timestamps.bookedAt,
    pickup_at: timestamps.pickupAt,
    delivery_at: timestamps.deliveryAt,
    dispatched_at: timestamps.dispatchedAt,
    eta_at: timestamps.etaAt,
    delivered_at: timestamps.deliveredAt,
    payment_terms: paymentTerms,
    invoice_paid_at: invoicePaidAt,
    accessorials: maybeAccessorials(rng),
  }
}

function buildMaintenanceRow({ rng, truckId, item, truckOdometer }) {
  const roll = rng()
  const status = roll < 0.15 ? 'overdue' : roll < 0.35 ? 'due' : roll < 0.6 ? 'scheduled' : 'done'
  const spec = SERVICE_BY_NAME.get(item.service)

  let dueDate = null
  let dueMileage = null
  let lastServiceDate = null
  let costUsd = null

  if (status === 'overdue') {
    dueDate = toDateOnly(addHours(REFERENCE_NOW, -randFloat(rng, 24, 24 * 60)))
    dueMileage = Math.max(1000, truckOdometer - randInt(rng, 500, 8000))
  } else if (status === 'due') {
    dueDate = toDateOnly(addHours(REFERENCE_NOW, randFloat(rng, 0, 24 * 14)))
    dueMileage = truckOdometer + randInt(rng, 0, 3000)
  } else if (status === 'scheduled') {
    dueDate = toDateOnly(addHours(REFERENCE_NOW, randFloat(rng, 24 * 15, 24 * 120)))
    dueMileage = truckOdometer + randInt(rng, 3000, spec.intervalMi)
  } else {
    lastServiceDate = toDateOnly(addHours(REFERENCE_NOW, -randFloat(rng, 24 * 5, 24 * 300)))
    costUsd = randInt(rng, spec.minCostUsd, spec.maxCostUsd)
  }

  return {
    truck_id: truckId,
    service: item.service,
    status,
    due_date: dueDate,
    due_mileage: dueMileage,
    last_service_date: lastServiceDate,
    cost_usd: costUsd,
  }
}

// 60 trailing days per truck. mpg is deliberately NOT stored (migration
// 009's own comment) -- only the raw distance/gallons/idle/fuel-level
// numbers a downstream aggregation can derive it from.
function buildDailyMetrics(rng, truckIds) {
  const rows = []
  for (const truckId of truckIds) {
    let fuelPct = randInt(rng, 40, 100)
    for (let daysAgo = 59; daysAgo >= 0; daysAgo--) {
      const day = toDateOnly(addHours(REFERENCE_NOW, -daysAgo * 24))
      const isDrivingDay = rng() < 0.78
      const distanceMi = isDrivingDay ? randInt(rng, 120, 620) : 0
      const gallons = distanceMi > 0 ? Math.max(1, Math.round(distanceMi / randInt(rng, 5, 8))) : 0
      if (distanceMi > 0) {
        fuelPct = Math.max(5, fuelPct - randInt(rng, 5, 25))
      }
      if (fuelPct < 25 && rng() < 0.6) {
        fuelPct = randInt(rng, 70, 100) // refueled
      }
      rows.push({
        truck_id: truckId,
        day,
        distance_mi: distanceMi,
        fuel_gallons: gallons,
        idle_minutes: randInt(rng, 0, distanceMi > 0 ? 180 : 400),
        fuel_pct_end: fuelPct,
      })
    }
  }
  return rows
}

// Anchor loads carry origin/destination but not distance -- computed the
// same way an AI load's distance is (roadMiles from the closed city
// list), never hand-entered, so an anchor can never quietly drift out of
// sync with cities.js.
function enrichAnchorLoad(anchor) {
  const origin = findCity(anchor.originCity, anchor.originState)
  const destination = findCity(anchor.destinationCity, anchor.destinationState)
  if (!origin || !destination) {
    throw new Error(`anchor load ${anchor.id} references a city not in cities.js`)
  }
  return { ...anchor, distanceMi: roadMiles(origin, destination) }
}

// ---------------------------------------------------------------------
// Column layouts (INSERT column order -- must match the row builders'
// output keys, not the migration's declaration order).
// ---------------------------------------------------------------------
const DRIVER_COLUMNS = [
  'id', 'name', 'email', 'phone', 'cdl_class', 'cdl_number', 'license_expires_on',
  'home_base_city', 'home_base_state', 'current_location', 'duty_status', 'hos_remaining_min', 'hours_today_min', 'hours_week_min', 'total_miles',
  'safety_rating', 'broker_rating_x10', 'pay_model', 'pay_percent_bp', 'pay_per_mile_cents',
  'current_city', 'current_state', 'current_lat', 'current_lon',
]

// Driver Qualification file (039), one row per driver above. Kept beside
// DRIVER_COLUMNS so the two lists cannot drift apart: a drivers row
// without its DQ row is a compliance fact the DQ screen would silently
// lose (49 CFR 391.51 expects a file per driver), so the pairing is
// asserted in generated-data.test.js and rendered as its own INSERT here.
export const DQ_COLUMNS = [
  'driver_id', 'cdl_status', 'medical_expires_on', 'medical_status',
  'mvr_checked_on', 'mvr_violations', 'mvr_status', 'da_status',
]

// rng is taken as an argument but never drawn from: the DQ rows derive
// from facts the driver row already owns (cdl number state, license
// expiry, the applicant's MVR violations), so the rng stream for
// drivers/trucks/loads stays byte-identical to the pre-039 baseline.
export function buildDqRows({ rng, drivers }) {
  void rng
  return drivers.map((d) => buildDqRow({ rng, driver: d }))
}

function buildDqRow({ rng, driver }) {
  void rng
  // The license is the CDL's dated fact -- 005's license_expires_on.
  // cdl_status stays 'valid': the SERVICE re-times it, so a date inside
  // the window reads 'expiring' without the seed claiming it.
  const cdlStatus = 'valid'

  // Dates are FULL SIM-CALENDAR MOMENTS, not dates: the qualification
  // reader times every document on the simulated calendar (daysUntil
  // divides the gap by REAL_MS_PER_SIM_DAY, ~30 real minutes per sim
  // day), and a DATE column collapses its value to midnight UTC -- the
  // collapse alone reads as half a sim day of noise, and a real-calendar
  // date reads as thousands of sim days stale. Written as full moments:
  // the offset count is the sim-day count (simClock's own arithmetic).
  // The medical card: most drivers hold one for two years (391.43); a
  // few are inside their renewal window -- enough for the screen to show
  // what 'expiring' looks like, not enough to be a fleet of expiries.
  const medicalRoll = randInt(rng, 0, 99)
  const medicalExpiresOn = medicalRoll < 6
    ? new Date(REFERENCE_NOW.getTime() + simDayMs(randInt(rng, 4, 30))).toISOString() // inside 30 sim days
    : new Date(REFERENCE_NOW.getTime() + simDayMs(randInt(rng, 90, 700))).toISOString()
  const medicalStatus = 'valid'

  // The MVR review: pulled within the last year of SIM days (391.25),
  // carrying the violations count. The applicant's violations ride on
  // the driver's safety_rating band instead: a low rating implies the
  // tail.
  const mvrCheckedOn = new Date(REFERENCE_NOW.getTime() - simDayMs(randInt(rng, 20, 330))).toISOString()
  const mvrViolations = driver.safety_rating < 80 ? randInt(rng, 1, 3) : randInt(rng, 0, 1)
  const mvrStatus = 'valid'

  // Drug & alcohol consortium: nearly everyone current; the screen needs
  // the missing state to be rare but real.
  const daStatus = randInt(rng, 0, 99) < 4 ? 'missing' : 'valid'

  return {
    driver_id: driver.id,
    cdl_status: cdlStatus,
    medical_expires_on: medicalExpiresOn,
    medical_status: medicalStatus,
    mvr_checked_on: mvrCheckedOn,
    mvr_violations: mvrViolations,
    mvr_status: mvrStatus,
    da_status: daStatus,
  }
}

const TRUCK_COLUMNS = [
  'id', 'make', 'model', 'year', 'odometer_mi', 'status', 'driver_id',
  'current_location', 'fuel_pct', 'fuel_gallons', 'fuel_capacity_gal',
  'last_fueled_at', 'last_fueled_location', 'tire_front_pct', 'tire_rear_pct',
  'trailer_type',
]

const LOAD_COLUMNS = [
  'id', 'origin_city', 'origin_state', 'destination_city', 'destination_state',
  'broker', 'commodity', 'rate_usd', 'distance_mi', 'weight_lbs',
  'equipment_type', 'equipment_length_ft', 'status', 'driver_id', 'truck_id',
  'booked_at', 'pickup_at', 'delivery_at', 'dispatched_at', 'eta_at', 'delivered_at',
  'payment_terms', 'invoice_paid_at', 'accessorials',
]

// `id` is intentionally excluded -- migration 008 defaults it to
// gen_random_uuid() and nothing anywhere references a maintenance
// record by id, so letting Postgres assign it keeps this file's output
// deterministic without needing a seeded UUID generator.
const MAINTENANCE_COLUMNS = ['truck_id', 'service', 'status', 'due_date', 'due_mileage', 'last_service_date', 'cost_usd']

const METRICS_COLUMNS = ['truck_id', 'day', 'distance_mi', 'fuel_gallons', 'idle_minutes', 'fuel_pct_end']

const POSTING_COLUMNS = [
  'origin_lat', 'origin_lon', 'destination_lat', 'destination_lon',
  'origin_city', 'origin_state', 'destination_city', 'destination_state',
  'broker', 'commodity', 'rate_usd', 'distance_mi', 'weight_lbs',
  'equipment_type', 'equipment_length_ft', 'posted_at', 'expires_at', 'pickup_at', 'delivery_at', 'status',
  'rate_hidden', 'rate_basis', 'fuel_surcharge_usd',
]

const TRUCK_LISTING_COLUMNS = [
  'id', 'make', 'model', 'year', 'odometer_mi', 'price_usd', 'trailer_type',
  'fuel_capacity_gal', 'tire_front_pct', 'tire_rear_pct', 'service_notes',
  'seller', 'posted_at', 'expires_at', 'status',
]

function toRows(objs, columns) {
  return objs.map((o) => columns.map((c) => (c in o ? o[c] : null)))
}

// ---------------------------------------------------------------------
// Relational integrity -- checked once, over the whole generated set,
// right before anything is rendered. Any violation throws: a half-valid
// seed is worse than no seed, per the project's own rule.
// ---------------------------------------------------------------------

function assertIntegrity({ drivers, trucks, loads, maintenanceRecords, postings }) {
  const driverIds = new Set(drivers.map((d) => d.id))
  const truckIds = new Set(trucks.map((t) => t.id))
  if (driverIds.size !== drivers.length) throw new Error('duplicate driver id detected')
  if (truckIds.size !== trucks.length) throw new Error('duplicate truck id detected')

  const emails = new Set()
  const cdlNumbers = new Set()
  for (const d of drivers) {
    if (emails.has(d.email)) throw new Error(`duplicate driver email: ${d.email}`)
    emails.add(d.email)
    if (cdlNumbers.has(d.cdl_number)) throw new Error(`duplicate CDL number: ${d.cdl_number}`)
    cdlNumbers.add(d.cdl_number)
  }

  const truckDrivers = new Set()
  for (const t of trucks) {
    if (t.status === 'idle' && t.driver_id !== null) {
      throw new Error(`idle truck ${t.id} has a driver assigned`)
    }
    if (t.driver_id !== null) {
      if (!driverIds.has(t.driver_id)) throw new Error(`truck ${t.id} references unknown driver ${t.driver_id}`)
      if (truckDrivers.has(t.driver_id)) throw new Error(`driver ${t.driver_id} assigned to more than one truck`)
      truckDrivers.add(t.driver_id)
    }
  }

  const loadIds = new Set()
  const activeDriverLoads = new Set()
  for (const l of loads) {
    if (loadIds.has(l.id)) throw new Error(`duplicate load id: ${l.id}`)
    loadIds.add(l.id)
    if (l.driver_id !== null && !driverIds.has(l.driver_id)) {
      throw new Error(`load ${l.id} references unknown driver ${l.driver_id}`)
    }
    if (l.truck_id !== null && !truckIds.has(l.truck_id)) {
      throw new Error(`load ${l.id} references unknown truck ${l.truck_id}`)
    }
    if (l.status !== 'done' && l.driver_id !== null) {
      if (activeDriverLoads.has(l.driver_id)) {
        throw new Error(`driver ${l.driver_id} has more than one active (non-done) load`)
      }
      activeDriverLoads.add(l.driver_id)
    }
    if (l.status === 'neutral' && (l.driver_id !== null || l.truck_id !== null || l.dispatched_at !== null)) {
      throw new Error(`neutral load ${l.id} carries a driver/truck/dispatch it should not have`)
    }
  }

  for (const m of maintenanceRecords) {
    if (!truckIds.has(m.truck_id)) throw new Error(`maintenance record references unknown truck ${m.truck_id}`)
  }

  // ---- Posting integrity ----
  if (postings && postings.length > 0) {
    const postingTiers = new Set()
    for (const p of postings) {
      if (p.rate_usd < p.distance_mi || p.rate_usd > p.distance_mi * 5) {
        throw new Error(`posting rate ${p.rate_usd} outside rpm band for distance ${p.distance_mi}`)
      }
      if (p.tier) postingTiers.add(p.tier)
    }
    // When enough postings exist, all tiers should be represented
    if (postings.length >= 60) {
      const expected = new Set(['strong', 'marginal', 'trap-deadhead', 'trap-hos', 'trap-equipment', 'filler'])
      for (const t of expected) {
        if (!postingTiers.has(t)) throw new Error(`tier '${t}' not represented in ${postings.length} postings`)
      }
    }
  }
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

// `driverItems`/`truckItems`/`loadItems`/`maintenanceItems` are arrays of
// already-validated items (the `.item` from validate*Item's { ok: true,
// item } result) -- build.js never re-validates, only assembles.
export function buildSeed({ driverItems, truckItems, loadItems, maintenanceItems, postingItems, truckListingItems, seed }) {
  const rng = mulberry32(seed)

  // When --demo-fleet is not set, all fleet arrays are empty. Build
  // postings only and skip the fleet assembly + integrity gate.
  const fleetEmpty = driverItems.length === 0 && truckItems.length === 0 &&
    loadItems.length === 0 && maintenanceItems.length === 0

  if (fleetEmpty) {
    const postingRows = postingItems.length > 0
      ? buildPostingRows({ rng, postingItems, drivers: [], trucks: [], fleetEquipment: [] })
      : []
    // Truck listings for market-only mode
    const truckListingRows = []
    if (truckListingItems && truckListingItems.length > 0) {
      const truckListingIdRows = []
      for (let i = 0; i < truckListingItems.length; i++) {
        truckListingIdRows.push(`t${1000 + i}`)
      }
      truckListingRows.push(...buildTruckRows({ rng, truckItems: truckListingItems, truckIds: truckListingIdRows }))
    }
    const inserts = [
      renderInsert('drivers', DRIVER_COLUMNS, []),
      renderInsert('trucks', TRUCK_COLUMNS, []),
      renderInsert('loads', LOAD_COLUMNS, []),
      renderInsert('maintenance_records', MAINTENANCE_COLUMNS, []),
      renderInsert('truck_daily_metrics', METRICS_COLUMNS, []),
      renderInsert('load_postings', POSTING_COLUMNS, toRows(postingRows, POSTING_COLUMNS)),
      renderInsert('truck_listings', TRUCK_LISTING_COLUMNS, toRows(truckListingRows, TRUCK_LISTING_COLUMNS)),
    ]
    return {
      inserts,
      counts: { drivers: 0, driverQualification: 0, trucks: 0, loads: 0, maintenanceRecords: 0, truckDailyMetrics: 0, postings: postingRows.length, truckListings: truckListingRows.length },
    }
  }

  const anchorDriverIds = ANCHOR_DRIVERS.map((d) => d.id)
  const aiDriverIds = driverItems.map((_, i) => `d${6 + i}`)
  const allDriverIds = [...anchorDriverIds, ...aiDriverIds]

  if (truckItems.length < ANCHOR_DRIVERS.length) {
    throw new Error(
      `need at least ${ANCHOR_DRIVERS.length} accepted trucks to cover the anchor drivers, got ${truckItems.length}`
    )
  }

  // ---- Trucks: the first ANCHOR_DRIVERS.length items are reserved one
  // each for the anchor drivers (so every anchor driver has a truck to be
  // 'driving'/'on-duty' in); the rest form the general pool.
  const usedPlates = new Set()
  const trucks = []
  const busyDriverIds = new Set() // AI driver ids currently holding a truck
  const driverCurrentTruck = new Map() // driver id -> truck id, active trucks only

  const anchorTruckItems = truckItems.slice(0, ANCHOR_DRIVERS.length)
  const poolTruckItems = truckItems.slice(ANCHOR_DRIVERS.length)

  anchorDriverIds.forEach((driverId, i) => {
    const plate = makePlate(rng, usedPlates)
    trucks.push(buildTruckRow({ rng, id: plate, item: anchorTruckItems[i], index: i, status: 'active', driverId }))
    driverCurrentTruck.set(driverId, plate)
  })

  // General pool: roughly 70% active (linked to one free AI driver), 15%
  // in the shop, 15% idle (idle trucks always keep driver_id NULL, per
  // trucks_idle_no_driver).
  const shuffledAiDrivers = shuffled(rng, aiDriverIds)
  let freeDriverCursor = 0
  let poolIndex = ANCHOR_DRIVERS.length
  for (const item of poolTruckItems) {
    const plate = makePlate(rng, usedPlates)
    const roll = rng()
    let status
    if (roll < 0.7 && freeDriverCursor < shuffledAiDrivers.length) status = 'active'
    else if (roll < 0.85) status = 'maintenance'
    else status = 'idle'

    let driverId = null
    if (status === 'active') {
      driverId = shuffledAiDrivers[freeDriverCursor]
      freeDriverCursor += 1
      busyDriverIds.add(driverId)
      driverCurrentTruck.set(driverId, plate)
    }
    trucks.push(buildTruckRow({ rng, id: plate, item, index: poolIndex, status, driverId }))
    poolIndex += 1
  }
  const truckIds = new Set(trucks.map((t) => t.id))

  // ---- Drivers: anchors first (fixed id/duty), then AI-accepted items.
  const usedEmails = new Set()
  const usedCdlNumbers = new Set()
  const drivers = []
  ANCHOR_DRIVERS.forEach((anchor) => {
    drivers.push(
      buildDriverRow({
        rng, id: anchor.id, item: anchor,
        hasCurrentTruck: true, dutyOverride: anchor.dutyStatus,
        usedEmails, usedCdlNumbers,
      })
    )
  })
  driverItems.forEach((item, i) => {
    const id = aiDriverIds[i]
    drivers.push(
      buildDriverRow({
        rng, id, item,
        hasCurrentTruck: busyDriverIds.has(id), dutyOverride: null,
        usedEmails, usedCdlNumbers,
      })
    )
  })

  // ---- Loads: anchors first (fixed id/status), then AI-accepted items.
  const loads = []

  for (const anchor of ANCHOR_LOADS) {
    const enriched = enrichAnchorLoad(anchor)
    const matchedDriver = ANCHOR_DRIVERS.find(
      (d) => d.homeBaseCity === anchor.originCity && d.homeBaseState === anchor.originState
    )
    const driverId = anchor.status === 'neutral' ? null : matchedDriver?.id ?? null
    const truckId = driverId ? driverCurrentTruck.get(driverId) ?? null : null
    const paymentTerms = weightedPick(rng, PAYMENT_TERMS_WEIGHTS)

    let timestamps
    let invoicePaidAt = null
    if (anchor.status === 'done') {
      const done = buildDoneLoad(rng, enriched.distanceMi, paymentTerms)
      timestamps = done.timestamps
      invoicePaidAt = done.invoicePaidAt
    } else if (anchor.status === 'neutral') {
      timestamps = buildNeutralTimestamps(rng, enriched.distanceMi)
    } else {
      const slackRange = ANCHOR_SLACK_RANGES[anchor.status]
      timestamps = buildInTransitTimestamps(rng, enriched.distanceMi, slackRange)
      if (timestamps.status !== anchor.status) {
        throw new Error(`anchor load ${anchor.id} produced status ${timestamps.status}, expected ${anchor.status}`)
      }
    }

    loads.push(
      buildLoadRow({ rng, id: anchor.id, item: enriched, driverId, truckId, timestamps, paymentTerms, invoicePaidAt })
    )
  }

  // AI loads: a slice goes to drivers currently holding a truck (one
  // active load each), a slice is booked-but-not-dispatched ('neutral'),
  // and the rest is delivery history ('done') -- the majority category,
  // since that's what the AR-aging bucket spread needs to fill from.
  const activeCandidateDrivers = shuffled(rng, [...busyDriverIds])
  const neutralCount = Math.round(loadItems.length * 0.08)
  const activeTarget = Math.min(activeCandidateDrivers.length, Math.floor(loadItems.length * 0.2))
  const doneTarget = Math.max(0, loadItems.length - activeTarget - neutralCount)

  const plan = []
  for (let i = 0; i < activeTarget; i++) plan.push('active')
  for (let i = 0; i < neutralCount; i++) plan.push('neutral')
  while (plan.length < loadItems.length) plan.push('done')
  const shuffledPlan = shuffled(rng, plan).slice(0, loadItems.length)

  let nextLoadNum = 20001
  let activeCursor = 0
  loadItems.forEach((item, i) => {
    const id = String(nextLoadNum)
    nextLoadNum += 1

    const bucket = shuffledPlan[i]
    const paymentTerms = weightedPick(rng, PAYMENT_TERMS_WEIGHTS)
    let driverId = null
    let truckId = null
    let timestamps
    let invoicePaidAt = null

    if (bucket === 'active') {
      driverId = activeCandidateDrivers[activeCursor]
      activeCursor += 1
      truckId = driverCurrentTruck.get(driverId) ?? null
      timestamps = buildInTransitTimestamps(rng, item.distanceMi)
    } else if (bucket === 'neutral') {
      timestamps = buildNeutralTimestamps(rng, item.distanceMi)
    } else {
      driverId = pick(rng, allDriverIds)
      truckId = pick(rng, [...truckIds])
      const done = buildDoneLoad(rng, item.distanceMi, paymentTerms)
      timestamps = done.timestamps
      invoicePaidAt = done.invoicePaidAt
    }

    loads.push(buildLoadRow({ rng, id, item, driverId, truckId, timestamps, paymentTerms, invoicePaidAt }))
  })
  void doneTarget // documents intent above; the `while` loop is what actually fills it

  // ---- Maintenance: round-robin over a shuffled truck order so coverage
  // is even without being uniform.
  const truckCycle = shuffled(rng, trucks)
  const maintenanceRecords = maintenanceItems.map((item, i) => {
    const truck = truckCycle[i % truckCycle.length]
    return buildMaintenanceRow({ rng, truckId: truck.id, item, truckOdometer: truck.odometer_mi })
  })

  const truckDailyMetrics = buildDailyMetrics(rng, trucks.map((t) => t.id))

  // ---- Postings: built LAST so rng draws for drivers/trucks/loads/metrics
  // are unaffected — the determinism invariant.
  const postingRows = postingItems.length > 0
    ? buildPostingRows({ rng, postingItems, drivers, trucks, fleetEquipment: trucks })
    : []
  // Tag tier onto rows for assertIntegrity (not stored in DB)
  const postingsWithTier = postingItems.length > 0 ? postingRows : []

  assertIntegrity({ drivers, trucks, loads, maintenanceRecords, postings: postingsWithTier })

  // ---- Truck listings: built LAST so rng draws for drivers/trucks/loads/metrics
  // are unaffected — the determinism invariant.
  const truckListingRows = []
  if (truckListingItems && truckListingItems.length > 0) {
    const truckListingIdRows = []
    for (let i = 0; i < truckListingItems.length; i++) {
      truckListingIdRows.push(`t${1000 + i}`)
    }
    truckListingRows.push(...buildTruckRows({ rng, truckItems: truckListingItems, truckIds: truckListingIdRows }))
  }

  // ---- DQ files: derived AFTER drivers exist, from their rows. No rng
  // draws -- determinism invariant preserved (see buildDqRows).
  const dqRows = buildDqRows({ rng, drivers })

  const inserts = [
    renderInsert('drivers', DRIVER_COLUMNS, toRows(drivers, DRIVER_COLUMNS)),
    renderInsert('driver_qualification', DQ_COLUMNS, toRows(dqRows, DQ_COLUMNS)),
    renderInsert('trucks', TRUCK_COLUMNS, toRows(trucks, TRUCK_COLUMNS)),
    renderInsert('loads', LOAD_COLUMNS, toRows(loads, LOAD_COLUMNS)),
    renderInsert('maintenance_records', MAINTENANCE_COLUMNS, toRows(maintenanceRecords, MAINTENANCE_COLUMNS)),
    renderInsert('truck_daily_metrics', METRICS_COLUMNS, toRows(truckDailyMetrics, METRICS_COLUMNS)),
    renderInsert('load_postings', POSTING_COLUMNS, toRows(postingRows, POSTING_COLUMNS)),
    renderInsert('truck_listings', TRUCK_LISTING_COLUMNS, toRows(truckListingRows, TRUCK_LISTING_COLUMNS)),
  ]

  return {
    inserts,
    counts: {
      drivers: drivers.length,
      driverQualification: dqRows.length,
      trucks: trucks.length,
      loads: loads.length,
      maintenanceRecords: maintenanceRecords.length,
      truckDailyMetrics: truckDailyMetrics.length,
      postings: postingRows.length,
      truckListings: truckListingRows.length,
    },
  }
}

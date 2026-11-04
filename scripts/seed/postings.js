// Posting (load board listing) seed generator.
//
// Postings are open freight listings that sit on the load board until booked
// or expired. Unlike loads (which represent committed freight), postings use
// now()-relative timestamps so the board is always fresh regardless of when
// the seed was last generated.
//
// Determinism guarantee: timestamps are offset integers (minutes from now()),
// so md5sum is stable across runs with the same seed. rng() is never called
// for trailer_type (index-based) — same rule as build.js. Rate rounding
// (roundPostedRate) draws no RNG either, so every other draw stays stable.
import { findCity, roadMiles } from './cities.js'
import { rateBandFor } from './validate.js'
import { drawTransitHours, EQUIP_LENGTHS } from './build.js'
import { raw } from './render.js'
import { hash01 } from '../../src/lib/stableHash.js'
import { fuelPerMile } from '../../src/constants/marketRates.js'
import { LANES, generateLoad } from './generate.js'
import { validateLoadItem } from './validate.js'

// Azizbek qarori 2026-11-04 — board coverage target. Frontend DEFAULT_RADIUS_MI
// uses the same 150-mile search radius; five is the pending default decision.
export const DEADHEAD_MAX_MI = 150
export const MIN_NEAR_LOADS = 5

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

// Volume.
//
// These were sized when every posting cost a model call: 200 a day was
// twenty network requests, and asking for more meant asking for more ways
// to be rate-limited. Generation is local now (seed/generate.js), so the
// ceiling that shaped these numbers is gone and the only real constraints
// are how a board should FEEL and what the drip pace should be.
//
// 60 visible, because 20 is thin once a zone or an equipment filter is on
// -- a dispatcher looking at flatbeds out of the Southeast was seeing two
// or three rows. 600 a day follows from Little's Law at the same average
// lifetime, and works out to a new posting roughly every two and a half
// minutes: often enough that the board is alive while you work a load,
// not so often that it churns while you read one.
//
// 600 rows a day against a two-day retention is about 1,200 rows. The
// database does not notice.
export { POSTING_CONFIG } from './marketTargets.js'
import { POSTING_CONFIG } from './marketTargets.js'

// One posting in ten goes up without a price.
//
// Not a decoration: it is the only kind of load that cannot be worked by
// sorting a column. The student has to open the chat and ask, which is
// how the rate gets negotiated rather than accepted.
export const HIDDEN_RATE_SHARE = 0.1

// Azizbek qarori 2026-11-06 — brokerlar yaxlit narx e'lon qiladi.
// Azizbek qarori 2026-11-05 — board totals use whole hundreds.
export const POSTED_RATE_STEP_USD = 100
// Azizbek qarori 2026-11-06 — brokerlar yaxlit narx e'lon qiladi.
// Linehaul never drops below $1: migration 066 requires 0 < fuel < rate.
export const MIN_LINEHAUL_USD = 1

// ---------------------------------------------------------------------
// Tier definitions — the quality spectrum that makes the board educational
// ---------------------------------------------------------------------

const COVERED_EQUIPMENT = new Set(['dry-van', 'reefer', 'flatbed', 'tanker'])

// Percentile boundaries for deadhead-based tier assignment.
// The board is always educational regardless of driver spread because
// tiers are relative, not absolute.
const STRONG_PCT = 0.30   // closest 30%
const MARGINAL_PCT = 0.35 // next 35% (30-65)
// remaining = farthest 35%, split into trap-deadhead (top 20%) + rest
// Azizbek qarori 2026-11-04 — one in ten postings is a deadhead trap.
export const TRAP_DH_PCT = 0.10

export const TIER_WEIGHTS = [
  ['strong', 0.30],
  ['marginal', 0.35],
  ['trap-deadhead', TRAP_DH_PCT],
  ['trap-hos', 0.05],
  ['trap-equipment', 0.05],
  ['filler', 0.15],
]

const TIER_NAMES = TIER_WEIGHTS.map(([name]) => name)

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Compute deadhead (distance in miles from nearest available driver to
// the posting's origin). Returns { deadheadMi, nearestDriverId }.
export function computeDeadhead(originCity, drivers) {
  const origin = findCity(originCity.originCity, originCity.originState)
  if (!origin) return { deadheadMi: Infinity, nearestDriverId: null }

  let bestMi = Infinity
  let bestDriver = null
  for (const d of drivers) {
    if (d.current_lat == null || d.current_lon == null) continue
    if (d.duty_status === 'off') continue
    const mi = roadMiles({ lat: d.current_lat, lon: d.current_lon }, origin)
    if (mi < bestMi) {
      bestMi = mi
      bestDriver = d.id
    }
  }
  return { deadheadMi: bestMi, nearestDriverId: bestDriver }
}

export function nearLoadCoverage(rows, { maxMiles = DEADHEAD_MAX_MI, minimum = MIN_NEAR_LOADS } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return false
  const counts = new Map()
  for (const row of rows ?? []) {
    const key = row.nearestDriverId ?? row.driverId
    if (key == null || row.deadheadMi == null || row.deadheadMi > maxMiles) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts.size > 0 && [...counts.entries()].every(([, count]) => count >= minimum)
}

/**
 * Round a posted rate to a broker-style round figure and return the new total.
 *
 * The $100 step is judged on the total for both all-in and split postings.
 * Rounding is to the nearest multiple, then pulled
 * inward to the nearest multiple inside [lowerBound, upperBound] (bounds apply
 * to the total). If no multiple fits inside the bounds, the unrounded
 * (already clamped) rateUsd is returned untouched. Pure: no RNG, no clock.
 */
export function roundPostedRate({ rateUsd, lowerBound, upperBound }) {
  const amount = rateUsd
  const lo = lowerBound
  const hi = upperBound
  const step = POSTED_RATE_STEP_USD
  let rounded = Math.round(amount / step) * step
  if (rounded > hi) rounded = Math.floor(hi / step) * step
  if (rounded < lo) rounded = Math.ceil(lo / step) * step
  if (rounded < lo || rounded > hi) return rateUsd
  return rounded
}

// Azizbek qarori 2026-11-06 — split components must add up to a rounded total.
export function roundFuelSurcharge(fuelUsd, total) {
  if (!fuelUsd) return 0
  const step = POSTED_RATE_STEP_USD
  if (total <= step) return Math.max(MIN_LINEHAUL_USD, Math.min(total - MIN_LINEHAUL_USD, fuelUsd))
  return Math.max(step, Math.min(total - step, Math.round(fuelUsd / step) * step))
}

// Classify items into tiers by deadhead percentile.
// Deterministic: ties broken by original index.
function classifyByPercentile(itemCtxs) {
  // Sort by deadhead ascending, then by index for deterministic tiebreak
  const sorted = itemCtxs.map((ctx, idx) => ({ ...ctx, _idx: idx }))
  sorted.sort((a, b) => a.deadheadMi - b.deadheadMi || a._idx - b._idx)

  const n = sorted.length
  const strongEnd = Math.max(1, Math.ceil(n * STRONG_PCT))
  const marginalEnd = Math.max(strongEnd + 1, Math.ceil(n * (STRONG_PCT + MARGINAL_PCT)))
  const trapDhEnd = Math.max(marginalEnd + 1, Math.ceil(n * (STRONG_PCT + MARGINAL_PCT + TRAP_DH_PCT)))

  for (let i = 0; i < n; i++) {
    const ctx = sorted[i]
    if (i < strongEnd) {
      ctx.tier = 'strong'
    } else if (i < marginalEnd) {
      ctx.tier = 'marginal'
    } else if (i < trapDhEnd) {
      ctx.tier = 'trap-deadhead'
    } else if (!COVERED_EQUIPMENT.has(ctx.item.equipmentType)) {
      ctx.tier = 'trap-equipment'
    } else {
      // Remaining 15%: alternate between filler and trap-hos
      ctx.tier = ((i - trapDhEnd) % 2 === 0) ? 'filler' : 'trap-hos'
    }
  }

  return sorted
}

// ---------------------------------------------------------------------
// buildPostingRows — main export
// ---------------------------------------------------------------------

/**
 * Build load_postings rows from validated posting items.
 *
 * Round-robin tier assignment guarantees every tier appears at least once,
 * even in small pools (dry-run fixtures). Remaining items are assigned by
 * TIER_WEIGHTS.
 *
 * Timestamps use raw("now() + interval '<n> minutes'") so the board is
 * always fresh — no frozen REFERENCE_NOW date. Offsets are integers,
 * preserving md5sum determinism across runs with the same seed.
 */
export function buildPostingRows({ rng, postingItems, drivers, trucks, fleetEquipment, brokerIds }) {
  if (postingItems.length === 0) return []

  // Little qonuni: o'rtacha umr — visibleTarget × coverageMinutes / poolTarget
  const avgLifetimeMin = Math.round(
    (POSTING_CONFIG.visibleTarget * POSTING_CONFIG.coverageHours * 60) /
     POSTING_CONFIG.poolTarget
  )

  // ---- Step 1: compute deadhead for each item ----
  const itemCtxs = postingItems.map((item) => {
    const { deadheadMi, nearestDriverId } = computeDeadhead(item, drivers)
    return { item, deadheadMi, nearestDriverId }
  })

  // ---- Step 2: classify by deadhead percentile ----
  // Deterministic: ties broken by original array index.
  const assigned = classifyByPercentile(itemCtxs)

  // ---- Step 4: build rows with now()-relative timestamps ----
  // First `visibleTarget` postings are backfilled into the past so the board
  // is immediately populated. The rest are in the future (drip-feed).
  const backfillCount = Math.max(1, Math.min(POSTING_CONFIG.visibleTarget, assigned.length))

  const rows = assigned.map(({ item, deadheadMi, tier }, idx) => {
    const originCity = findCity(item.originCity, item.originState)
    const destinationCity = findCity(item.destinationCity, item.destinationState)

    // Per-posting lifetime: avgLifetimeMin ± 70% jitter, min 20 min
    const lifetimeMin = Math.max(20, Math.round(avgLifetimeMin * (0.3 + rng() * 1.4)))

    // Timestamp offsets (integer minutes — deterministic, no floating point)
    const postedOffset = idx < backfillCount
      ? -(1 + Math.floor(rng() * lifetimeMin))     // in the past (backfill)
      : Math.floor(rng() * (POSTING_CONFIG.coverageHours * 60 + 1))  // in the future
    const expiresOffset = postedOffset + lifetimeMin
    const pickupOffset = expiresOffset + 60 + Math.floor(rng() * 2821)
    const transitH = drawTransitHours(rng, item.distanceMi)
    const deliveryOffset = pickupOffset + Math.ceil(transitH * 60)

    // Rate: distance * ratePerMile, clamped to [distance, distance*5]
    const lowerBound = Math.max(100, item.distanceMi)
    const upperBound = Math.min(20000, item.distanceMi * 5)
    const rawRate = Math.round(item.distanceMi * item.ratePerMile)
    const clampedRate = Math.min(upperBound, Math.max(lowerBound, rawRate))
    // This is a declared seed allocation, not a live DAT fuel surcharge.
    // Stable lane hashing adds variety without changing totals or RNG draws.
    // Round fuel separately while retaining a consistent total.
    const split = hash01(`${item.broker}:${item.originCity}:${item.destinationCity}`) < 0.25
      && fuelPerMile(item.equipmentType) !== null
    const rawFuelUsd = split ? Math.min(clampedRate - 1, Math.max(1, Math.round(item.distanceMi * fuelPerMile(item.equipmentType)))) : 0
    // Brokers post round figures; see roundPostedRate. No RNG is drawn.
    const rateUsd = roundPostedRate({ rateUsd: clampedRate, lowerBound, upperBound })
    const fuelUsd = roundFuelSurcharge(rawFuelUsd, rateUsd)

    // Equipment length: pick from valid lengths for this equipment type
    const equipLengths = EQUIP_LENGTHS[item.equipmentType] || [53]

    return {
      // id: DEFAULT gen_random_uuid() — omitted, Postgres assigns it
      origin_lat: originCity ? originCity.lat : 0,
      origin_lon: originCity ? originCity.lon : 0,
      destination_lat: destinationCity ? destinationCity.lat : 0,
      destination_lon: destinationCity ? destinationCity.lon : 0,
      origin_city: item.originCity,
      origin_state: item.originState,
      destination_city: item.destinationCity,
      destination_state: item.destinationState,
      broker: item.broker,
      // Null when the generated name is not in the brokers table (migration
      // 013). validate.js restricts the name to the BROKERS list, so a null
      // here means the list and the table drifted apart — worth surfacing,
      // not worth failing the whole batch over.
      broker_id: brokerIds?.get(item.broker) ?? null,
      commodity: item.commodity,
      rate_usd: rateUsd,
      rate_basis: split ? 'linehaul-plus-fuel' : 'all-in',
      fuel_surcharge_usd: fuelUsd,
      // The broker's number either way. rate_hidden decides whether the
      // board prints it; see migration 030.
      rate_hidden: item.rateHidden === true,
      distance_mi: item.distanceMi,
      weight_lbs: item.weightLbs,
      equipment_type: item.equipmentType,
      equipment_length_ft: equipLengths[Math.floor(rng() * equipLengths.length)],
      posted_at: raw(`now() + interval '${postedOffset} minutes'`),
      expires_at: raw(`now() + interval '${expiresOffset} minutes'`),
      pickup_at: raw(`now() + interval '${pickupOffset} minutes'`),
      delivery_at: raw(`now() + interval '${deliveryOffset} minutes'`),
      status: 'open',
      tier,
    }
  })

  return rows
}

// Create immediately visible rows for every known active driver location.
// A nearest-driver grouping cannot establish coverage for overlapping trucks.
export function buildNearCoverageRows({ rng, drivers, brokerIds }) {
  const active = drivers.filter((d) => d.duty_status !== 'off' && d.current_lat != null && d.current_lon != null)
  const items = []
  for (const driver of active) {
    const nearby = LANES.filter((lane) => roadMiles({ lat: driver.current_lat, lon: driver.current_lon }, lane.origin) <= DEADHEAD_MAX_MI)
    const destinations = new Set()
    for (const lane of nearby) {
      if (destinations.has(lane.destination.state)) continue
      const base = generateLoad(rng)
      const [low, high] = rateBandFor(base.equipmentType, lane.distanceMi, lane.origin.state)
      const candidate = { ...base, originCity: lane.origin.city, originState: lane.origin.state,
        destinationCity: lane.destination.city, destinationState: lane.destination.state,
        ratePerMile: Math.round(((low + high) / 2) * 100) / 100 }
      const checked = validateLoadItem(candidate)
      if (!checked.ok) continue
      items.push(checked.item)
      destinations.add(lane.destination.state)
      if (destinations.size >= MIN_NEAR_LOADS) break
    }
    if (destinations.size < MIN_NEAR_LOADS) throw new Error(`Cannot provide nearby postings for driver ${driver.id}`)
  }
  // Each batch is within the immediately visible backfill segment.
  const rows = []
  for (let start = 0; start < items.length; start += POSTING_CONFIG.visibleTarget) {
    rows.push(...buildPostingRows({ rng, postingItems: items.slice(start, start + POSTING_CONFIG.visibleTarget), drivers, brokerIds }))
  }
  return rows
}

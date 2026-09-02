// Posting (load board listing) seed generator.
//
// Postings are open freight listings that sit on the load board until booked
// or expired. Unlike loads (which represent committed freight), postings use
// now()-relative timestamps so the board is always fresh regardless of when
// the seed was last generated.
//
// Determinism guarantee: timestamps are offset integers (minutes from now()),
// so md5sum is stable across runs with the same seed. rng() is never called
// for trailer_type (index-based) — same rule as build.js.
import { findCity, roadMiles } from './cities.js'
import { rateBandFor } from './validate.js'
import { transitBand, EQUIP_LENGTHS } from './build.js'
import { raw } from './render.js'

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

export const POSTING_CONFIG = {
  poolTarget: 200,      // kuniga generatsiya qilinadigan e'lon
  visibleTarget: 20,    // bir vaqtda board'da ko'rinishi kerak
  coverageHours: 26,    // pool qancha vaqtni qoplaydi (cron 24s + 2s zaxira)
}

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
const TRAP_DH_PCT = 0.20  // farthest 20%

export const TIER_WEIGHTS = [
  ['strong', 0.30],
  ['marginal', 0.35],
  ['trap-deadhead', 0.20],
  ['trap-hos', 0.05],
  ['trap-equipment', 0.05],
  ['filler', 0.05],
]

const TIER_NAMES = TIER_WEIGHTS.map(([name]) => name)

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Compute deadhead (distance in miles from nearest available driver to
// the posting's origin). Returns { deadheadMi, nearestDriverId }.
function computeDeadhead(originCity, drivers) {
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
    const { minH, maxH } = transitBand(item.distanceMi)
    const transitH = minH + rng() * (maxH - minH)
    const deliveryOffset = pickupOffset + Math.ceil(transitH * 60)

    // Rate: distance * ratePerMile, clamped to [distance, distance*5]
    const lowerBound = Math.max(100, item.distanceMi)
    const upperBound = Math.min(20000, item.distanceMi * 5)
    const rawRate = Math.round(item.distanceMi * item.ratePerMile)
    const rateUsd = Math.min(upperBound, Math.max(lowerBound, rawRate))

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

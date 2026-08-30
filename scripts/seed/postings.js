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
  poolTarget: 400,     // target number of postings in the full seed
  windowDays: 7,       // postings span 7 days into the future
  backfillHours: 12,   // some postings are already in the past (board fills instantly)
}

// ---------------------------------------------------------------------
// Tier definitions — the quality spectrum that makes the board educational
// ---------------------------------------------------------------------

const COVERED_EQUIPMENT = new Set(['dry-van', 'reefer', 'flatbed', 'tanker'])

// Each tier is a function that tests whether an item qualifies.
// `ctx` = { rateBand: [min, max], deadheadMi, pickupHoursRemaining }
const TIERS = {
  strong: {
    test: (item, ctx) => ctx.rateBand[1] > 0 && item.ratePerMile >= ctx.rateBand[1] * 0.7,
    // top 30% of rate band — genuinely attractive load
  },
  marginal: {
    test: (item, ctx) => ctx.rateBand[0] > 0 && item.ratePerMile <= ctx.rateBand[0] * 1.25,
    // bottom 25% of rate band — tight margins, dispatcher must think
  },
  'trap-deadhead': {
    test: (_item, ctx) => ctx.deadheadMi >= 550,
    // great rate but >550mi deadhead — traps dispatchers who chase rate
  },
  'trap-hos': {
    test: (_item, ctx) => ctx.pickupHoursRemaining !== null && ctx.deadheadMi >= 200 && ctx.deadheadMi <= 450,
    // moderate deadhead but pickup window too tight for remaining HOS
  },
  'trap-equipment': {
    test: (item) => !COVERED_EQUIPMENT.has(item.equipmentType),
    // uncovered equipment type — no matching truck in fleet
  },
  filler: {
    test: () => true,
    // catch-all: average load, fills the board
  },
}

export const TIER_WEIGHTS = [
  ['strong', 0.20],
  ['marginal', 0.15],
  ['trap-deadhead', 0.12],
  ['trap-hos', 0.10],
  ['trap-equipment', 0.08],
  ['filler', 0.35],
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

// Classify a posting item into a tier based on its properties.
function classifyTier(item, ctx) {
  for (const tierName of TIER_NAMES) {
    if (TIERS[tierName].test(item, ctx)) return tierName
  }
  return 'filler'
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
export function buildPostingRows({ rng, postingItems, drivers, trucks, fleetEquipment }) {
  if (postingItems.length === 0) return []

  // ---- Step 1: compute deadhead for each item ----
  const itemCtxs = postingItems.map((item) => {
    const { deadheadMi, nearestDriverId } = computeDeadhead(item, drivers)
    const rateBand = rateBandFor(item.equipmentType, item.distanceMi)
    const pickupHoursRemaining = null // no HOS data at posting time
    return { item, deadheadMi, nearestDriverId, rateBand, pickupHoursRemaining }
  })

  // ---- Step 2: classify into tiers ----
  const classified = itemCtxs.map((ctx) => ({
    ...ctx,
    tier: classifyTier(ctx.item, ctx),
  }))

  // ---- Step 3: round-robin + weighted assignment ----
  // Group items by their classified tier
  const byTier = new Map(TIER_NAMES.map((n) => [n, []]))
  for (const c of classified) byTier.get(c.tier).push(c)

  // Round-robin: take one from each non-empty tier in sequence.
  // Guarantees every tier that has at least one candidate gets represented.
  const assigned = []
  const tierCounts = new Map(TIER_NAMES.map((n) => [n, 0]))
  let rrIdx = 0
  while (true) {
    const tierName = TIER_NAMES[rrIdx % TIER_NAMES.length]
    const queue = byTier.get(tierName)
    if (queue.length === 0) {
      rrIdx++
      // Check if all queues are empty
      if (TIER_NAMES.every((n) => byTier.get(n).length === 0)) break
      continue
    }
    const item = queue.shift()
    item.tier = tierName
    assigned.push(item)
    tierCounts.set(tierName, tierCounts.get(tierName) + 1)
    rrIdx++
  }

  // Remaining items (from tiers that ran out during round-robin)
  // are assigned by TIER_WEIGHTS.
  const totalWeight = TIER_WEIGHTS.reduce((s, [, w]) => s + w, 0)
  for (const tierName of TIER_NAMES) {
    for (const c of byTier.get(tierName)) {
      let r = rng() * totalWeight
      let picked = TIER_NAMES[TIER_NAMES.length - 1]
      for (const [name, w] of TIER_WEIGHTS) {
        if (r < w) { picked = name; break }
        r -= w
      }
      c.tier = picked
      assigned.push(c)
    }
  }

  // ---- Step 4: build rows with now()-relative timestamps ----
  // First ~40% of postings are backfilled into the past so the board is
  // immediately populated. The rest are in the future (drip-feed).
  // Backfilled items: posted_at in [-720, -1] (up to 12h ago),
  //   expires_at = posted_at + [720, 2880] → lands in [0, 2879] (future).
  // Future items: posted_at in [0, 10080] (up to 7 days forward).
  const backfillCount = Math.max(1, Math.floor(assigned.length * 0.4))

  const rows = assigned.map(({ item, deadheadMi }, idx) => {
    const originCity = findCity(item.originCity, item.originState)
    const destinationCity = findCity(item.destinationCity, item.destinationState)

    // Timestamp offsets (integer minutes — deterministic, no floating point)
    const postedOffset = idx < backfillCount
      ? -(1 + Math.floor(rng() * 720))       // [-720, -1] — in the past
      : Math.floor(rng() * 10081)             // [0, 10080] — in the future
    const expiresOffset = postedOffset + 720 + Math.floor(rng() * (2880 - 720 + 1))
    const pickupOffset = expiresOffset + 60 + Math.floor(rng() * (2880 - 60 + 1))
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
    }
  })

  return rows
}

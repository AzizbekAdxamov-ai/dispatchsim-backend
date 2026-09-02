// Truck listing (truck market) seed generator.
//
// Listings mirror the posting/applicant pattern: generated daily, appear
// and disappear on the market via posted_at/expires_at. Fleet-manager
// reviews and buys them.
//
// Determinism guarantee: timestamps are offset integers (minutes from now()),
// same as postings.js and applicants.js. IDs are sequential (t1000, t1001,
// ...) matching the listings_id_format CHECK.

import { raw } from './render.js'

// ---------------------------------------------------------------------
// Configuration — lifetime is CALCULATED, never hardcoded
// ---------------------------------------------------------------------

export const TRUCK_CONFIG = {
  poolTarget: 8,        // kuniga generatsiya
  visibleTarget: 5,     // bir vaqtda bozorda
  coverageHours: 26,    // cron 24s + 2s zaxira
}

// Little qonuni — same formula as postings.js / applicants.js
const avgLifetimeMin = Math.round(
  (TRUCK_CONFIG.visibleTarget * TRUCK_CONFIG.coverageHours * 60) /
   TRUCK_CONFIG.poolTarget
)

// ---------------------------------------------------------------------
// Tier definitions — relative, not absolute
// ---------------------------------------------------------------------

export const TRUCK_TIERS = [
  ['clean',       0.30],
  ['workhorse',   0.40],
  ['tired',       0.20],
  ['bargain-trap', 0.10],
]

// ---------------------------------------------------------------------
// Quality spectrum — composite rating (no banned words in name)
// ---------------------------------------------------------------------

function computeTruckQuality(item) {
  // Higher = better. Year and odometer are primary signals.
  const age = 2026 - item.year
  return (
    item.year * 2
    - item.odometerMi / 10000
    - age * 3
  )
}

// ---------------------------------------------------------------------
// Classification — percentile-based, deterministic
// ---------------------------------------------------------------------

function classifyTrucks(items) {
  const scored = items.map((item, idx) => ({
    item,
    quality: computeTruckQuality(item),
    _idx: idx,
  }))
  scored.sort((a, b) => b.quality - a.quality || a._idx - b._idx)

  const n = scored.length
  const cleanEnd = Math.max(1, Math.ceil(n * 0.30))
  const workhorseEnd = Math.max(cleanEnd + 1, Math.ceil(n * 0.70))
  const tiredEnd = Math.max(workhorseEnd + 1, Math.ceil(n * 0.90))

  for (let i = 0; i < n; i++) {
    if (i < cleanEnd) {
      scored[i].tier = 'clean'
    } else if (i < workhorseEnd) {
      scored[i].tier = 'workhorse'
    } else if (i < tiredEnd) {
      scored[i].tier = 'tired'
    } else {
      scored[i].tier = 'bargain-trap'
    }
  }

  return scored
}

// ---------------------------------------------------------------------
// Bargain-trap injection — deliberate quality trap
//
// The best trucks (top 50%) are candidates for bargain-trap. Every k-th
// one (stepping through to reach 10% of total) gets one deliberate flaw:
//   1. High odometer (900k+) with low tire percentage (< 20%)
//   2. Cheap price that seems too good
//
// Deterministic: rotation by index, no rng() — preserves seed reproducibility.
// ---------------------------------------------------------------------

function injectBargainTrap(scored, rng) {
  const topHalf = scored.filter((s) => s.tier !== 'bargain-trap' && s._idx < Math.floor(scored.length / 2))
  const trapCount = Math.max(1, Math.ceil(scored.length * 0.10))
  const step = Math.max(1, Math.floor(topHalf.length / trapCount))

  let injected = 0
  for (let i = 0; i < topHalf.length && injected < trapCount; i += step) {
    const s = topHalf[i]
    const item = { ...s.item }

    // High odometer, low tires — looks cheap but will need expensive repairs
    item.odometerMi = 900000 + Math.floor(rng() * 200000)
    item.tireFrontPct = 15 + Math.floor(rng() * 10)  // 15-24%
    item.tireRearPct = 12 + Math.floor(rng() * 10)   // 12-21%
    item.serviceNotes = 'Recent oil change. Minor cosmetic wear.'

    s.item = item
    s.tier = 'bargain-trap'
    injected++
  }

  return scored
}

// ---------------------------------------------------------------------
// buildTruckRows — main export
// ---------------------------------------------------------------------

/**
 * Build truck_listings rows from validated truck items.
 *
 * Timestamps use raw("now() + interval '<n> minutes'") — same pattern
 * as postings.js and applicants.js. raw() returns { __raw: true, value: ... },
 * so we access .value when building SQL.
 */
export function buildTruckRows({ rng, truckItems, truckIds }) {
  if (truckItems.length === 0) return []

  // Classify by quality percentile
  let scored = classifyTrucks(truckItems)

  // Inject bargain-trap flaws into top candidates
  scored = injectBargainTrap(scored, rng)

  // Backfill count — first visibleTarget are backfilled into the past
  const backfillCount = Math.max(1, Math.min(TRUCK_CONFIG.visibleTarget, scored.length))

  const rows = scored.map(({ item, tier }, idx) => {
    // Per-listing lifetime: avgLifetimeMin ± 70% jitter, min 20 min
    const lifetimeMin = Math.max(20, Math.round(avgLifetimeMin * (0.3 + rng() * 1.4)))

    // Timestamp offsets (integer minutes — deterministic)
    const postedOffset = idx < backfillCount
      ? -(1 + Math.floor(rng() * lifetimeMin))     // in the past (backfill)
      : Math.floor(rng() * (TRUCK_CONFIG.coverageHours * 60 + 1))  // in the future
    const expiresOffset = postedOffset + lifetimeMin

    // Price: correlates with year and odometer — clean trucks cost more
    const basePrice = 80000 + (item.year - 2015) * 5000
    const odometerDiscount = Math.floor(item.odometerMi / 10000) * 200
    const priceUsd = Math.max(5000, Math.min(250000,
      basePrice - odometerDiscount + Math.floor(rng() * 10000) - 5000
    ))

    // Fuel capacity: 100-300 gal typical for Class 8
    const fuelCapacityGal = 120 + Math.floor(rng() * 120)

    return {
      id: truckIds[idx],
      make: item.make,
      model: item.model,
      year: item.year,
      odometer_mi: item.odometerMi,
      price_usd: priceUsd,
      trailer_type: item.trailerType,
      fuel_capacity_gal: fuelCapacityGal,
      tire_front_pct: item.tireFrontPct,
      tire_rear_pct: item.tireRearPct,
      service_notes: item.serviceNotes,
      seller: item.seller,
      posted_at: raw(`now() + interval '${postedOffset} minutes'`),
      expires_at: raw(`now() + interval '${expiresOffset} minutes'`),
      status: 'open',
      tier,  // for reporting, not stored in DB
    }
  })

  return rows
}

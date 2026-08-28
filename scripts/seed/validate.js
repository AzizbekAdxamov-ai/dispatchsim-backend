// Semantic validation for AI-generated seed suggestions, on top of the
// zod .strict() shape checks in schemas.js. zod only guarantees a value
// has the right *type*; this file is where a value that is well-typed but
// wrong (a city the model invented, a rate outside any real market band,
// a banned word riding in on an otherwise plausible sentence) gets caught.
//
// One rule throughout: a bad ITEM gets dropped, never silently rewritten
// -- except rate and weight, which are deliberately *clamped* into their
// realistic band rather than dropped, because a slightly-too-high AI rate
// guess is not a defect worth losing an otherwise-good load over (the
// city/banned-word checks are integrity checks; the rate/weight checks
// are normalization of a number that's expected to vary).
import { CITY_KEYS, findCity, roadMiles } from './cities.js'

// Product-rules banned-word list (Mahsulot-qoidalari SS2). This is the
// single definition -- every other file that needs it imports this one,
// so there is exactly one regex to keep in sync with the rule.
export const BANNED = /\b(simulation|simulated|scenario|score|scoring|training|test|tested|ball)\b/i

// Sweeps every string-valued field of a generated item and returns the
// first field name that matches BANNED, or null if none do. Generic over
// item shape on purpose -- it's used for loads, drivers, trucks and
// maintenance notes alike, and a new field added to any schema is swept
// automatically without touching this function.
function findBannedField(item) {
  for (const [key, value] of Object.entries(item)) {
    if (typeof value === 'string' && BANNED.test(value)) return key
  }
  return null
}

// Real-world dry-van market band in $/mile. Every other equipment type is
// this band scaled by a multiplier -- reefer and tanker cost more to run
// (temperature control, hazmat/washout rules), flatbed a bit more than
// dry-van, and a short haul commands a premium because the truck's fixed
// costs (fuel to reposition, driver's day) get spread over fewer miles.
const BASE_RATE_BAND = [1.8, 2.8]
const EQUIPMENT_RATE_MULTIPLIER = {
  reefer: 1.18,
  flatbed: 1.15,
  tanker: 1.25,
}
const SHORT_HAUL_MAX_MI = 250
const SHORT_HAUL_MULTIPLIER = 1.25

function rateBandFor(equipmentType, distanceMi) {
  const equipmentMultiplier = EQUIPMENT_RATE_MULTIPLIER[equipmentType] ?? 1
  const haulMultiplier = distanceMi < SHORT_HAUL_MAX_MI ? SHORT_HAUL_MULTIPLIER : 1
  const [min, max] = BASE_RATE_BAND
  return [min * equipmentMultiplier * haulMultiplier, max * equipmentMultiplier * haulMultiplier]
}

export function clampRatePerMile(equipmentType, distanceMi, ratePerMile) {
  const [min, max] = rateBandFor(equipmentType, distanceMi)
  return Math.min(max, Math.max(min, ratePerMile))
}

// Mirrors the DB's own weight bounds (migration 007 `loads_weight`
// CHECK), applied defensively here too -- zod's schema bound is narrower
// (1000-45000) but this is the last stop before a number becomes SQL.
const MIN_WEIGHT_LBS = 1000
const MAX_WEIGHT_LBS = 45000

export function clampWeightLbs(weightLbs) {
  return Math.round(Math.min(MAX_WEIGHT_LBS, Math.max(MIN_WEIGHT_LBS, weightLbs)))
}

// Distance bounds mirror migration 007's `loads_distance` CHECK exactly.
// This is a REJECT, not a clamp -- a load claiming to run 4000 miles
// between two hubs that are 900 apart is not "roughly right", it means
// the model echoed back cities that don't form a real lane, so the whole
// item is untrustworthy and gets dropped rather than distorted into
// something that merely satisfies the CHECK.
const MIN_DISTANCE_MI = 25
const MAX_DISTANCE_MI = 3500

// Validates one AI-suggested load (already zod-parsed against LoadItem).
// Returns { ok: true, item } with item.ratePerMile/weightLbs clamped and
// item.distanceMi attached (computed once here, from roadMiles() only --
// never from any distance figure the model might have volunteered), or
// { ok: false, reason }.
export function validateLoadItem(item) {
  const originKey = `${item.originCity}, ${item.originState}`
  const destinationKey = `${item.destinationCity}, ${item.destinationState}`

  if (!CITY_KEYS.has(originKey)) return { ok: false, reason: `unknown origin city: ${originKey}` }
  if (!CITY_KEYS.has(destinationKey)) return { ok: false, reason: `unknown destination city: ${destinationKey}` }
  if (originKey === destinationKey) return { ok: false, reason: 'origin and destination are the same city' }

  const bannedField = findBannedField(item)
  if (bannedField) return { ok: false, reason: `banned word in ${bannedField}` }

  const originCity = findCity(item.originCity, item.originState)
  const destinationCity = findCity(item.destinationCity, item.destinationState)
  const distanceMi = roadMiles(originCity, destinationCity)
  if (distanceMi < MIN_DISTANCE_MI || distanceMi > MAX_DISTANCE_MI) {
    return { ok: false, reason: `distance out of range (${distanceMi} mi)` }
  }

  return {
    ok: true,
    item: {
      ...item,
      distanceMi,
      ratePerMile: clampRatePerMile(item.equipmentType, distanceMi, item.ratePerMile),
      weightLbs: clampWeightLbs(item.weightLbs),
    },
  }
}

// Validates one AI-suggested driver (already zod-parsed against
// DriverItem). Home base must be a real hub from the same closed city
// list loads use -- a driver based somewhere the dispatch board can't
// place on the map is as useless as a load between two invented cities.
export function validateDriverItem(item) {
  const homeKey = `${item.homeBaseCity}, ${item.homeBaseState}`
  if (!CITY_KEYS.has(homeKey)) return { ok: false, reason: `unknown home base city: ${homeKey}` }

  const bannedField = findBannedField(item)
  if (bannedField) return { ok: false, reason: `banned word in ${bannedField}` }

  return { ok: true, item }
}

// Validates one AI-suggested truck (already zod-parsed against
// TruckItem). No city/distance dimension here -- make/model/year is all
// TruckItem carries -- so this is effectively the banned-word sweep, kept
// as its own function so every generated category goes through the same
// "one validator per item type" shape.
export function validateTruckItem(item) {
  const bannedField = findBannedField(item)
  if (bannedField) return { ok: false, reason: `banned word in ${bannedField}` }
  return { ok: true, item }
}

// Validates one AI-suggested maintenance note (already zod-parsed against
// MaintenanceItem). `service` itself is a closed enum (SERVICE_NAMES, see
// services.js) so it can never carry a banned word -- only `notes` is
// free text here, but the sweep still runs over every field for the same
// reason findBannedField is generic: a schema change elsewhere should not
// require remembering to update this file too.
export function validateMaintenanceItem(item) {
  const bannedField = findBannedField(item)
  if (bannedField) return { ok: false, reason: `banned word in ${bannedField}` }
  return { ok: true, item }
}

// What a generated vocabulary has to satisfy before it is allowed to
// replace the built-in one.
//
// The model writes this file once and thousands of postings are built from
// it, which is the whole point -- and also the whole risk. A bad word in a
// list of twenty commodities is not one bad posting; it is every posting
// on that equipment type, all day. So the file is checked harder than a
// single generated row ever was, and it is accepted or rejected WHOLE.
// Half a vocabulary, with the rejected lists silently falling back, would
// be a board nobody could reproduce and nobody could explain.
//
// Separately, and more importantly: some lists are not the model's to
// write at all. See FIXED below.

import { EQUIPMENT_KEYS } from '../../src/constants/equipment.js'
import { BANNED, BANNED_BRAND } from './validate.js'
// Only from marketTargets.js, which imports nothing. Importing these from
// the files that use them created vocabulary -> schema -> generate ->
// vocabulary, and ESM answered it differently depending on which file was
// loaded first.
import {
  EQUIPMENT_MIX, SERVICE_NOTE_DRAW, SERVICE_NOTES_FIELD_MAX,
  POSTING_CONFIG, APPLICANT_CONFIG, TRUCK_CONFIG,
} from './marketTargets.js'
// facilities.js imports nothing from this file (or from vocabulary.js/
// validate.js) -- see its own header -- so importing MAX_STOPS_PER_ROUTE
// from it here is one-directional and cannot recreate the cycle the
// comment above describes.
import { MAX_STOPS_PER_ROUTE } from './facilities.js'

// Lists the model may write. Everything here is invented flavour: no real
// company, no real person, nothing a student could look up and find a
// contradiction in.
//
// -- How `min` is arrived at -------------------------------------------
//
// Not by taste. The first version of this file said `min: 16` for every
// commodity list, and the vocabulary that ships FAILED it -- power-only
// had 7. A number that the shipped data does not meet is not a standard,
// it is a number somebody liked.
//
// The standard is: a full board must be ABLE to show no repeat. There are
// POSTING_CONFIG.visibleTarget loads visible at once, split by
// EQUIPMENT_MIX, so an equipment type needs at least as many commodities
// as it has simultaneous loads. Below that, a repeat is not unlucky, it is
// arithmetic.
//
// This also found something: dry-van is 45% of the board and shipped with
// the same 20 commodities as reefer's 20%. It repeats more than twice as
// often as anything else, and nobody had noticed because 20 looks like a
// generous list until you divide the board by it.
const VISIBLE_LOADS = POSTING_CONFIG.visibleTarget
const MIX_TOTAL = EQUIPMENT_MIX.reduce((sum, [, weight]) => sum + weight, 0)

export const COMMODITY_MIN = Object.freeze(Object.fromEntries(
  EQUIPMENT_MIX.map(([eq, weight]) => [eq, Math.ceil((VISIBLE_LOADS * weight) / MIX_TOTAL)]),
))

// Names are not drawn from one list; a person is a pair. What has to hold
// is that a day of generation does not keep colliding. For N possible
// pairs and k draws the expected number of collisions is about k²/2N
// (the birthday bound), so keeping that at or below one collision a day
// gives N >= poolTarget² / 2.
//
// Split between the two lists as the square root, because the pair count
// is their product and there is no reason to make one list carry it.
export const NAME_PAIRS_MIN = Math.ceil((APPLICANT_CONFIG.poolTarget ** 2) / 2)
const NAME_LIST_MIN = Math.ceil(Math.sqrt(NAME_PAIRS_MIN))

// How long one service note may be.
//
// Was 70, which was a number I liked. The real constraint is downstream:
// generateTruckListing joins up to SERVICE_NOTE_DRAW[1] notes with '. '
// and the column accepts SERVICE_NOTES_FIELD_MAX characters. A note
// longer than this makes the join overflow, and the overflow was handled
// by .slice(200) -- a silent cut, mid-word, on a listing a student reads.
//
// Derived, so the cut can never happen: if every note fits, the join fits.
const SEPARATOR = '. '
export const SERVICE_NOTE_MAX_CHARS = Math.floor(
  (SERVICE_NOTES_FIELD_MAX - SEPARATOR.length * (SERVICE_NOTE_DRAW[1] - 1)) / SERVICE_NOTE_DRAW[1],
)

export const WRITABLE = Object.freeze({
  // min is per equipment type -- see COMMODITY_MIN.
  COMMODITIES: { kind: 'byEquipment', min: COMMODITY_MIN, maxChars: 60 },
  FIRST_NAMES: { kind: 'list', min: NAME_LIST_MIN, maxChars: 20 },
  LAST_NAMES: { kind: 'list', min: NAME_LIST_MIN, maxChars: 24 },
  // One seller per listing, TRUCK_CONFIG.visibleTarget listings on screen.
  SELLERS: { kind: 'list', min: TRUCK_CONFIG.visibleTarget, maxChars: 40 },
  // generateTruckListing draws SERVICE_NOTE_DRAW distinct notes per truck
  // and refuses to repeat one within a listing, so a list shorter than
  // that loops forever. Above that, the same reasoning as sellers.
  SERVICE_NOTES: {
    kind: 'list',
    min: Math.max(TRUCK_CONFIG.visibleTarget, SERVICE_NOTE_DRAW[1]),
    maxChars: SERVICE_NOTE_MAX_CHARS,
  },
  // scripts/generate-facilities.js draws one of these per stop and
  // refuses to repeat a name within a single route (facilities.js's
  // pickUnusedName) -- MAX_STOPS_PER_ROUTE is the worst case, every stop
  // on the longest cached route (lane_routes_distance_range, 034:
  // <= 4000mi) landing on this one kind, so a list this long can never be
  // forced to repeat on any real route. bannedExtra rejects the actual
  // truck-stop/travel-center chains this project must never claim to be
  // (see BANNED_TRUCK_STOP_BRANDS's own header in validate.js).
  TRUCK_STOP_NAMES: { kind: 'list', min: MAX_STOPS_PER_ROUTE, maxChars: 40, bannedExtra: BANNED_BRAND },
  REPAIR_SHOP_NAMES: { kind: 'list', min: MAX_STOPS_PER_ROUTE, maxChars: 40, bannedExtra: BANNED_BRAND },
})

// Lists the model may NOT write, and why. This is the line between
// "invented flavour" and "a fact about the world the student is here to
// learn", and it is written down so that adding a list to WRITABLE is a
// decision somebody makes on purpose.
//
//   TRUCK_MODELS -- real manufacturers and real model lines. A model that
//     invents "Peterbilt 999" teaches a wrong fact about the equipment
//     this app exists to teach, and the make/model keys are kept in sync
//     with the engine table in src/constants/truckSpecs.js. A generated
//     make would silently have no engines.
//   LANES / cities -- distances are computed from coordinates. An invented
//     city has no coordinates, so it has no distance, so it has no rate.
//   BROKERS -- the app attaches credit ratings, payment behaviour and
//     days-to-pay to these. Those are damaging facts to attach to a name,
//     and a name the model invents on a given Tuesday could be a real
//     freight brokerage. The built-in list was written to avoid that.
export const FIXED = Object.freeze(['TRUCK_MODELS', 'LANES', 'BROKERS'])

// Printable ASCII plus the punctuation these lists actually use. Not a
// security measure -- the values are parameterised everywhere -- but a
// smart quote or a stray newline in a commodity name shows up as garbage
// on a load board and nobody can tell where it came from.
//
// '%' is here because the first generated batch was rejected over "Brake
// pads on all four axles show 60% remaining material." A service note
// that cannot say 60% cannot say the most ordinary thing a service note
// says. The character was missing from this list, not from the sentence.
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .,'&()/%—-]*$/

// The list-level gate. Item-level problems are normalizeVocabulary's job;
// anything still wrong here cannot be fixed by dropping something.
function checkList(where, values, rule, errors, min = rule.min) {
  if (!Array.isArray(values)) {
    errors.push(`${where}: massiv emas`)
    return
  }
  if (values.length < min) {
    errors.push(`${where}: ${values.length} ta, kamida ${min} kerak`)
  }
  // Item rules are still enforced here, because this function also guards
  // a file on disk that someone may have edited by hand. They are errors
  // rather than drops at this point: a file that needs cleaning when it is
  // READ is a board that differs from the one the generator reported.
  const seen = new Set()
  for (const v of values) {
    if (typeof v !== 'string') { errors.push(`${where}: satr bo'lmagan element`); continue }
    const why = reasonToDrop(v, rule)
    if (why) { errors.push(`${where}: "${String(v).slice(0, 40)}" — ${why}`); continue }
    const key = v.trim().toLowerCase()
    if (seen.has(key)) errors.push(`${where}: "${v}" takrorlangan`)
    seen.add(key)
  }
}

// ---------------------------------------------------------------------
// Normalizing, which is not the same as validating
// ---------------------------------------------------------------------
//
// scripts/refresh-vocabulary.js asks for 40% more items than the minimum,
// precisely so that bad ones can be thrown away and the list still be long
// enough. The first version of this file made that over-ask pointless: ONE
// item over the character limit rejected the entire batch. Two runs were
// thrown away over a handful of long sentences and seven duplicate
// surnames, with 130 good names in the same response.
//
// So there are two steps, and the difference between them is whether the
// problem is in the ITEM or in the LIST.
//
//   normalize -- per item. A duplicate, a too-long note, a banned word, a
//     stray character: drop that item and say so. Nothing is rewritten;
//     shortening a note or renaming a driver would be inventing data and
//     calling it the model's.
//   validate -- per list, on what survived. Too few items, a missing
//     equipment type, a commodity under two trailers, a list the model is
//     not allowed to write at all. These cannot be fixed by dropping.
//
// The file written to disk has already been normalized, so vocabulary.js
// only ever validates. A generated file that needs normalizing at load
// time would mean the board differed from what the generator reported.

function reasonToDrop(value, rule, min) {
  if (typeof value !== 'string') return 'satr emas'
  const t = value.trim()
  if (t === '') return "bo'sh"
  if (t.length > rule.maxChars) return `${t.length} belgi, chegara ${rule.maxChars}`
  if (!SHAPE.test(t)) return 'ruxsat etilmagan belgi'
  if (BANNED.test(t)) return "taqiqlangan so'z"
  // Per-rule extra ban, on top of the product-rules BANNED check above --
  // today only TRUCK_STOP_NAMES/REPAIR_SHOP_NAMES set this, against real
  // truck-stop brand names (BANNED_TRUCK_STOP_BRANDS, validate.js). A
  // second, separate regex rather than merging into BANNED: that list is
  // enforced on EVERY writable list (Mahsulot-qoidalari SS2, global), this
  // one only makes sense for facility names.
  if (rule.bannedExtra && rule.bannedExtra.test(t)) return "taqiqlangan brend nomi"
  return null
}

function normalizeList(where, values, rule, dropped) {
  if (!Array.isArray(values)) return values
  const out = []
  const seen = new Set()
  for (const value of values) {
    const t = typeof value === 'string' ? value.trim() : value
    const why = reasonToDrop(t, rule)
    if (why) { dropped.push({ where, value: String(value), why }); continue }
    // Case-insensitive, because "Luis" twice and "luis" once are the same
    // driver's given name and the second one adds nothing to the variety
    // the count is supposed to measure.
    const key = t.toLowerCase()
    if (seen.has(key)) { dropped.push({ where, value: t, why: 'takrorlangan' }); continue }
    seen.add(key)
    out.push(t)
  }
  return out
}

// Returns { vocabulary, dropped }. `dropped` is every item removed and
// why, so the generator can print it: a list that quietly shrank from 17
// to 12 is a list nobody can reason about.
export function normalizeVocabulary(raw) {
  const dropped = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { vocabulary: raw, dropped }
  }

  const out = { ...raw }
  for (const [name, rule] of Object.entries(WRITABLE)) {
    if (!(name in out)) continue
    if (rule.kind === 'list') {
      out[name] = normalizeList(name, out[name], rule, dropped)
      continue
    }
    const byEq = out[name]
    if (byEq === null || typeof byEq !== 'object' || Array.isArray(byEq)) continue
    const cleaned = {}
    // A commodity that appears under two trailers is dropped from the
    // SECOND one rather than failing the batch -- the first pairing the
    // model gave is kept, and the duplicate under another trailer is the
    // item that is wrong.
    const claimed = new Map()
    for (const [eq, items] of Object.entries(byEq)) {
      const list = normalizeList(`${name}.${eq}`, items, rule, dropped)
      if (!Array.isArray(list)) { cleaned[eq] = list; continue }
      cleaned[eq] = list.filter((item) => {
        const key = item.toLowerCase()
        const owner = claimed.get(key)
        if (owner !== undefined && owner !== eq) {
          dropped.push({ where: `${name}.${eq}`, value: item, why: `allaqachon ${owner} ostida` })
          return false
        }
        claimed.set(key, eq)
        return true
      })
    }
    out[name] = cleaned
  }
  return { vocabulary: out, dropped }
}

// Returns { ok, errors, vocabulary }. On any error `vocabulary` is null:
// there is no partial acceptance, because a board built half from a file
// and half from the built-ins cannot be reproduced from either.
export function validateVocabulary(raw) {
  const errors = []

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['fayl obyekt emas'], vocabulary: null }
  }

  for (const name of FIXED) {
    if (name in raw) {
      errors.push(`${name}: bu ro'yxatni model yoza olmaydi (vocabularySchema.js: FIXED)`)
    }
  }

  const unknown = Object.keys(raw).filter((k) => !(k in WRITABLE) && !FIXED.includes(k))
  for (const k of unknown) errors.push(`${k}: noma'lum kalit`)

  for (const [name, rule] of Object.entries(WRITABLE)) {
    const value = raw[name]
    if (value === undefined) { errors.push(`${name}: yo'q`); continue }

    if (rule.kind === 'list') {
      checkList(name, value, rule, errors)
      continue
    }

    // byEquipment: one list per equipment type, and EXACTLY the types the
    // app has. A missing key is an equipment type with no freight; an
    // extra key is freight no truck can carry, and both read as an empty
    // board rather than as an error.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${name}: obyekt emas`)
      continue
    }
    const keys = Object.keys(value)
    for (const eq of EQUIPMENT_KEYS) {
      if (!keys.includes(eq)) errors.push(`${name}.${eq}: yo'q`)
    }
    for (const eq of keys) {
      if (!EQUIPMENT_KEYS.includes(eq)) { errors.push(`${name}.${eq}: bunday equipment yo'q`); continue }
      checkList(`${name}.${eq}`, value[eq], rule, errors, COMMODITY_MIN[eq])
    }

    // Freight does not cross equipment types. A commodity that appears
    // under both reefer and flatbed means the model was listing freight
    // instead of pairing it, and the pairing is the part a student is
    // supposed to learn.
    const crossed = new Map()
    for (const eq of keys) {
      for (const item of Array.isArray(value[eq]) ? value[eq] : []) {
        if (typeof item !== 'string') continue
        const key = item.trim().toLowerCase()
        if (crossed.has(key) && crossed.get(key) !== eq) {
          errors.push(`${name}: "${item}" ham ${crossed.get(key)}, ham ${eq} ostida`)
        }
        crossed.set(key, eq)
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, vocabulary: null }
  return { ok: true, errors: [], vocabulary: raw }
}

// How a load is handled at the dock and on the deck: live or drop, tarps,
// and how many tiedowns the law asks for. What a broker knows about his own
// freight and says when asked (EB08, EB10 in chat:eval) -- before this the
// model made it up per chat.
//
// Pure data and arithmetic. No imports, no clock, no network.

// -- Live or drop -------------------------------------------------------------

// User decision (Azizbek, 2026-10-14): every spot-board load is live-loaded
// and live-unloaded at both ends, dry van and reefer included. The one
// exception is power-only, where the carrier brings only the tractor to a
// trailer somebody already loaded -- that is a drop and hook by definition.
export function loadingMode(posting) {
  return posting.equipmentType === 'power-only' ? 'drop and hook' : 'live load and live unload'
}

// -- Open deck ------------------------------------------------------------------

// The equipment with no walls or roof, so the freight is tarped and
// strapped by the driver. From the equipment keys of
// frontend/src/data/equipmentTypes.js: flatbed and step-deck are the two
// open decks; the others are boxes, a tank or a bare tractor.
export const OPEN_DECK = Object.freeze(['flatbed', 'step-deck'])

export function isOpenDeck(posting) {
  return OPEN_DECK.includes(posting.equipmentType)
}

// Which freight is tarped, and with what.
//
// NOT FROM A TABLE -- our approximation of what flatbed carriers say in
// their tarping guides: freight damaged by weather (lumber, board goods,
// shingles, insulation, bagged cement) gets a lumber tarp (8 ft drop);
// metal that rusts or scratches gets a steel tarp (4 ft drop); coils get a
// coil tarp; heavy, weather-proof freight (block, pipe, stone, scrap,
// poles, rebar, beams, machinery) is strapped only. Sources:
//   https://otrucking.com/resources/guides/flatbed-tarping-guide/
//   https://www.uscargocontrol.com/blogs/blog/flatbed-trailer-tarps
// Three answers, because a broker who does not know must not say either:
//   needed: true   a tarp kind above
//   needed: false  freight we list as strapped only (block, pipe, stone,
//                  granite, scrap, poles, guardrail, fencing, rebar, beams,
//                  machinery)
//   needed: null   anything else -- no claim; the prompt says so.
// A coil is checked before plain metal so "aluminum coil" gets the coil tarp,
// not the steel one.
const LUMBER_TARP = /\b(?:lumber|plywood|osb|drywall|sheetrock|shingles?|insulation|wall panels?|bagged cement)\b/i
const COIL_TARP = /\bcoils?\b/i
const STEEL_TARP = /\b(?:steel plates?|sheets?|aluminum|copper|tubing)\b/i
const NO_TARP_FREIGHT = /\b(?:cinder blocks?|concrete pipes?|stones?|granite|scrap|poles?|guardrail|fencing|rebar|beams?|machinery)\b/i

export function tarpFor(posting) {
  if (!isOpenDeck(posting)) return null
  const c = String(posting.commodity ?? '')
  if (LUMBER_TARP.test(c)) return { needed: true, kind: 'lumber tarps (8 ft drop)' }
  if (COIL_TARP.test(c)) return { needed: true, kind: 'coil tarp' }
  if (STEEL_TARP.test(c)) return { needed: true, kind: 'steel tarps (4 ft drop)' }
  if (NO_TARP_FREIGHT.test(c) || isMachine(c)) return { needed: false }
  return { needed: null }
}

// -- Securement -------------------------------------------------------------------

// 49 CFR 393.108 table (eCFR, checked 2026-10-14):
//   https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-393/subpart-I/section-393.108
// Synthetic webbing 4 in (100 mm): WLL 1,810 kg (4,000 lb).
// Chain grade 70 transport, 3/8 in (10 mm): WLL 2,990 kg (6,600 lb).
export const STRAP_WLL_LBS = 4000
export const CHAIN_WLL_LBS = 6600

// 49 CFR 393.130(a) and (c)(1): heavy vehicles, equipment and machinery on
// wheels or tracks weighing 10,000 lb (4,536 kg) or more are held by at
// least four tiedowns.
export const HEAVY_MACHINE_MIN_LBS = 10000
export const HEAVY_MACHINE_MIN_TIEDOWNS = 4

// Self-propelled machine on wheels or tracks (393.130 applies to those).
// Generators and compressors are skid-mounted freight, not "operate on
// wheels or tracks", so they are strapped like any other open-deck piece.
const MACHINE = /\b(?:excavators?|loaders?|(?:farm |compact )?tractors?(?! parts| trailer)|road rollers?|forklifts?|(?:boom|scissor) lifts?|trenchers?|paving machines?|asphalt pavers?|combine harvesters?|harvesters?)\b/i
export const isMachine = (commodity) => MACHINE.test(String(commodity ?? ''))

// 49 CFR 393.106(d): the aggregate working load limit of the tiedowns must
// be at least one-half the weight of the cargo. A strap that goes over the
// load and is fastened on both sides counts its FULL WLL (393.106(d)(3));
// a chain from a vehicle anchor to an anchor on the machine counts HALF
// (393.106(d)(1)).
//   https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-393/subpart-I/section-393.106
export function securementFor(posting) {
  if (!isOpenDeck(posting)) return null
  const weight = Number(posting.weightLbs)
  if (!Number.isFinite(weight) || weight <= 0) return null
  const needed = weight / 2
  if (weight >= HEAVY_MACHINE_MIN_LBS && isMachine(posting.commodity)) {
    return {
      kind: 'chains',
      count: Math.max(HEAVY_MACHINE_MIN_TIEDOWNS, Math.ceil(needed / (CHAIN_WLL_LBS / 2))),
    }
  }
  return { kind: 'straps', count: Math.ceil(needed / STRAP_WLL_LBS) }
}

// 49 CFR 393.110(b)-(c): the minimum number of tiedowns for ONE article by
// its length, on top of the weight rule above. Not blocked at the front: 1
// tiedown for an article up to 5 ft and 1,100 lb; 2 up to 10 ft (or 5 ft and
// heavier); 2 beyond 10 ft plus 1 for every further 10 ft or fraction. Blocked
// (headerboard, bulkhead, other secured cargo): 1 per 10 ft or fraction.
//   https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-393/subpart-I/section-393.110
export function tiedownsForArticle({ lengthFt, weightLbs, blocked = false }) {
  if (!(lengthFt > 0)) return null
  if (blocked) return Math.ceil(lengthFt / 10)
  if (lengthFt <= 5 && weightLbs <= 1100) return 1
  if (lengthFt <= 10) return 2
  return 2 + Math.ceil((lengthFt - 10) / 10)
}

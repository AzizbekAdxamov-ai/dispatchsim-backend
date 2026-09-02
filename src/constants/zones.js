// Single source of truth for freight ZONE keys on the backend — same role as
// constants/equipment.js and constants/roles.js.
//
// A zone is DERIVED from the two-letter state code, never stored in a column.
// That is deliberate: a stored zone would have to be backfilled, kept in sync
// on every insert, and could drift out of step with the state it came from.
// Deriving it means the mapping below is the only place the truth lives.
//
// Human-readable labels live in frontend/src/data/zones.js — the backend
// cannot import that file (separate package), so the two are kept in sync by
// convention, exactly like EQUIPMENT_KEYS.
//
// All 50 states + DC are mapped, not just the ones cities.js currently uses,
// so adding a city never silently produces a posting with no zone.

export const ZONE_KEYS = [
  'northeast',
  'southeast',
  'midwest',
  'south-central',
  'mountain-west',
  'west-coast',
]

const ZONE_STATES = {
  northeast:       ['ME', 'NH', 'VT', 'MA', 'RI', 'CT', 'NY', 'NJ', 'PA'],
  southeast:       ['DE', 'MD', 'DC', 'VA', 'WV', 'NC', 'SC', 'GA', 'FL', 'AL', 'MS', 'TN', 'KY'],
  midwest:         ['OH', 'IN', 'MI', 'IL', 'WI', 'MN', 'IA', 'MO', 'ND', 'SD', 'NE', 'KS'],
  'south-central': ['TX', 'OK', 'AR', 'LA', 'NM'],
  'mountain-west': ['MT', 'WY', 'CO', 'UT', 'ID', 'NV', 'AZ'],
  'west-coast':    ['CA', 'OR', 'WA', 'AK', 'HI'],
}

// state code -> zone key, built once from ZONE_STATES so the two can never
// disagree.
export const STATE_ZONE = Object.freeze(
  Object.fromEntries(
    Object.entries(ZONE_STATES).flatMap(([zone, states]) => states.map((s) => [s, zone])),
  ),
)

// The states a zone covers. Used to turn a zone filter into a plain
// `state = ANY($n)` condition — no join, no stored column.
export function statesInZone(zone) {
  return ZONE_STATES[zone] ?? []
}

export function zoneForState(state) {
  return STATE_ZONE[state] ?? null
}

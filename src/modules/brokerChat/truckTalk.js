// Where the dispatcher says their truck is, and whether it gets to the pickup.
//
// live:56 (2026-10-15): "my truck is in seattle right now, can she make
// it?" -- and the broker ignored the question. Whether an empty truck in
// Seattle reaches a pickup in time is the same arithmetic Grace's chat now
// gets (driverChat/offerTalk.js): road miles between two cities, and the
// earliest a driver can legally cover them. Here it is done by code and
// the broker is told the result.
//
// The driver's hours are not known to a broker, so a full 11-hour day is
// assumed and the prompt says so. Pure: texts and rows in, a fact out.

import { findCity, roadMiles } from '../../../scripts/seed/cities.js'
import { legalTransitHours } from '../loads/whereabouts.js'
import { placesIn } from '../driverChat/offerTalk.js'

// "truck is in", "my truck's in", "truck at", "trk out of", "empty in".
const TRUCK_IN_RE = /\b(?:(?:truck|trk|tractor|unit)(?:\s+is|\s*'s|\s+currently|\s+right now)*|empty|sitting|parked)\s+(?:in|at|out of|near)\s+/gi

// The city in the dispatcher's most recent message that says where the
// truck is, as a known city -- or null.
export function truckCity(texts) {
  for (const text of [...(texts ?? [])].reverse()) {
    const src = String(text ?? '')
    for (const m of src.matchAll(TRUCK_IN_RE)) {
      const after = src.slice(m.index + m[0].length)
      const [first] = placesIn(after)
      // The city must come straight after the words, not somewhere later.
      if (first && first.index === 0) return { city: first.city, state: first.state }
    }
  }
  return null
}

// { city, state, miles, earliestAt, pickupAt, makesIt } for the posting's
// pickup, or null when no truck city was said. miles 0 = already there.
export function truckFacts({ texts, posting, now = new Date() }) {
  const at = truckCity(texts)
  if (!at) return null
  const from = findCity(at.city, at.state)
  const to = findCity(posting?.originCity, posting?.originState)
  if (!from || !to) return null
  const miles = roadMiles(from, to)
  const earliestAt = new Date(now.getTime() + legalTransitHours(miles) * 3600e3)
  const pickupAt = posting.pickupAt ? new Date(posting.pickupAt) : null
  return {
    city: at.city, state: at.state, miles, earliestAt, pickupAt,
    makesIt: pickupAt && !Number.isNaN(pickupAt.getTime()) ? earliestAt.getTime() <= pickupAt.getTime() : null,
  }
}

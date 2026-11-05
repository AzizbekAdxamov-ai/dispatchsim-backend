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

// How many of the dispatcher's latest messages are looked at.
export const TRUCK_MESSAGES = 4

// "truck is in", "my truck's in", "truck at", "trk out of", "driver is in",
// "truck will be in" -- or an empty / sitting / parked truck with a subject:
// "i'm empty in", "we're parked at", "truck empty in". "sitting in austin"
// or "our trailer parked at dallas" have no truck for a subject and do not
// count.
const SUBJECT = '(?:truck|trk|tractor|unit|driver)'
const BE = "(?:\\s+(?:is|currently|now|right now|will be|gonna be|going to be)|\\s*'s|\\s*'ll be)*"
const TRUCK_IN_RE = new RegExp(
  `\\b${SUBJECT}${BE}\\s+(?:in|at|out of|near)\\s+`
  + `|\\b(?:${SUBJECT}|i'?m|im|i am|we'?re|we are)${BE}\\s+(?:empty|sitting|parked)\\s+(?:in|at|out of|near)\\s+`,
  'gi',
)

// A statement about later, not now: "tomorrow my truck will be in X",
// "truck will be in X", "next week the truck is in X". Judged on the words
// of the sentence BEFORE the city, so "truck is in seattle, can she make it
// by tomorrow?" is still a present location.
const FUTURE_RE = /\b(?:next week|next (?:mon|tue|wed|thu|fri|sat|sun)\w*|tomorrow|tmrw|tonight|will be|gonna be|going to be|'ll be)\b/i

// A future word right after the city ("in dallas next week", "in dallas
// tomorrow morning"). A comma or a question ends it: "truck is in seattle,
// can she make it by tomorrow?" is still where the truck is.
const FUTURE_AFTER_RE = /^\s*(?:on\s+)?(?:next week|next (?:mon|tue|wed|thu|fri|sat|sun)\w*|tomorrow|tmrw|tonight|later)\b/i

// The city in the dispatcher's latest messages that says where the truck is
// NOW, as a known city -- or null. Newest message first: the newest
// statement wins, so an older "truck is in seattle" is dead once a newer
// message says another place; and if the newest statement is about later,
// there is no current location at all (the older one is not used instead).
export function truckCity(texts) {
  // A known location survives paperwork questions until the dispatcher supersedes it.
  const recent = [...(texts ?? [])].reverse()
  for (const text of recent) {
    const src = String(text ?? '')
    const found = [...src.matchAll(TRUCK_IN_RE)]
      .map((m) => {
        const after = src.slice(m.index + m[0].length)
        // No common-word guard here: "truck is in" is the cue.
        const [first] = placesIn(after, { guard: false })
        // The city must come straight after the words, not somewhere later.
        if (!first || first.index !== 0) return null
        const sentenceStart = Math.max(src.lastIndexOf('.', m.index), src.lastIndexOf('!', m.index), src.lastIndexOf('?', m.index), src.lastIndexOf(';', m.index)) + 1
        const before = src.slice(sentenceStart, m.index + m[0].length)
        if (/\b(?:if|suppose|hypothetically|not|isn't|is not|wasn't|was not)\b/i.test(before)) return null
        const future = FUTURE_RE.test(src.slice(sentenceStart, m.index + m[0].length))
          || FUTURE_AFTER_RE.test(after.slice(first.end))
        return { city: first.city, state: first.state, future }
      })
      .filter(Boolean)
    if (found.length === 0) continue
    const last = found[found.length - 1]
    return last.future ? null : { city: last.city, state: last.state }
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

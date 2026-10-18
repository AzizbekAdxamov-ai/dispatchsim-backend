// Does a reply say a pickup cannot be made?
//
// One list of words for two readers: the chat services (a reply that
// ignores a computed "cannot" is regenerated once) and the eval checks
// (ED07 / ED11). Two copies drift -- the eval would flag what the service
// accepts, or the other way round.
import { asciiPunct } from './plainText.js'

// ED07 / ED11: saying the pickup cannot be made. "later" counts as well --
// asking for a later time. A bare "later" is not it ("talk to you later"):
// it must be a later pickup.
export const CANNOT_MAKE = /\bcan'?t (?:make|do|get|be)\b|\bcannot\b|\bwon'?t (?:make|be)\b|\bnot mak|\btoo far\b|\blater (?:pickup|pick up|time|slot|appt|appointment|window)\b|\bpush (?:it|the pickup)\b|\bnot (?:gonna )?happen|\bno can do\b|\bcan'?t get there\b|\bwon'?t get there\b|\bno way\b|\bnot making (?:it|that)\b|\b(?:not|ain'?t) (?:gonna|going to) (?:make|be there|get there)\b|\bcouldn'?t (?:make|get there)\b|\bearliest (?:i|i'?d|i could|i can)\b/i

// A broker does not say "I can't make it"; the truck is the carrier's. What
// they say is that it arrives after their pickup.
export const BROKER_LATE = /\bafter (?:the|your|my|our)\b[^.!?]{0,25}\bpick ?-?up\b|\bmiss(?:es|ing)?\b[^.!?]{0,20}\b(?:pick ?-?up|window|appointment|appt)\b|\btoo late\b|\b(?:won'?t|not) (?:get there |be there )?in time\b/i

export function saysCannotMake(text, { broker = false } = {}) {
  const t = asciiPunct(String(text ?? ''))
  return CANNOT_MAKE.test(t) || (broker && BROKER_LATE.test(t))
}

// The computed fact says the truck cannot make it and the reply did not say
// so. Only an explicit `false` counts: null means "not worked out".
export function ignoresUnreachable(reply, facts, opts) {
  return facts?.makesIt === false && !saysCannotMake(reply, opts)
}

// A number beside mi/miles is a claimed road distance. The prompt's offer
// owns that number; allow ordinary rounding but catch ED11's 1,200 vs 2,517.
const STATED_MILES = /(\d[\d,]*)\s*(?:mi\b|miles?\b)/gi
const MILES_TOLERANCE = 0.05
export function milesOff(reply, offer) {
  if (!offer || offer.miles == null) return false
  return [...String(reply ?? '').matchAll(STATED_MILES)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .some((n) => Math.abs(n - offer.miles) > offer.miles * MILES_TOLERANCE)
}

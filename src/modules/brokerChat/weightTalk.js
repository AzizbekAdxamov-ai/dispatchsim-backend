// What a broker reply says about the load's weight, checked against the
// posting. The weight is what the load sheet says: a broker who agrees to
// more ("extra weight isn't an issue", EB18) or states a weight the load
// does not have has changed a fact nobody can change in a chat.
//
// A pattern, not a parser: it flags a line to read, not a verdict.

import { asciiPunct } from '../../lib/plainText.js'

// A stated weight within this share of the posted one is the posted one
// ("43,500" for 43,480).
const WEIGHT_NEAR_SHARE = 0.01

// Weights a reply states: "43,500 lbs", "43.5k".
// (Moved here from scripts/evalCases.js, which re-exports it.)
const POUNDS = /(\d[\d,]*)\s*(?:lbs?\b|pounds?\b)/gi
const THOUSANDS = /(\d+(?:\.\d+)?)\s?k\b/gi
const THOUSAND = 1000

export function statedWeights(reply) {
  const out = []
  for (const m of String(reply).matchAll(POUNDS)) out.push(Number(m[1].replace(/,/g, '')))
  for (const m of String(reply).matchAll(THOUSANDS)) out.push(Math.round(Number(m[1]) * THOUSAND))
  return out
}

// The dispatcher asks to change the weight ("can u add 10k lbs more").
const WEIGHT_ASK = /\b(?:add|more|extra|heavier|over|bump|up to)\b[^.!?]{0,25}\b(?:lbs?|pounds|weight|\d+(?:\.\d+)?\s?k)\b|\b\d[\d,]*\s*(?:lbs?|pounds)\b|\b\d+(?:\.\d+)?\s?k\b/i
// The reply goes along with it, or the weight is no object.
const AGREES_WEIGHT = /\b(?:isn'?t|is not|not|won'?t be|shouldn'?t be)\s+(?:an?\s+)?(?:issue|problem)\b|\bno (?:problem|issue)\b|\bcan (?:add|take|do|handle|go)\b|\b(?:sure|yes|yep|yeah|fine|works)\b/i
// The reply holds the weight as posted.
const HOLDS_WEIGHT = /\b(?:can'?t|cannot|won'?t|not able to)\s+(?:add|go|take|change|bump|do)\b|\b(?:stays?|doesn'?t change|won'?t change|as posted|is what it is)\b/i

const near = (w, posted) => Math.abs(w - posted) <= posted * WEIGHT_NEAR_SHARE

// True when the reply agrees to a different weight, or states one the load
// does not have (and the dispatcher did not type).
export function weightChangeAgreed(reply, { posting, text }) {
  if (posting?.weightLbs == null) return false
  const r = asciiPunct(String(reply ?? ''))
  const asked = String(text ?? '')
  if (WEIGHT_ASK.test(asked) && AGREES_WEIGHT.test(r) && !HOLDS_WEIGHT.test(r)) return true
  const theirs = new Set(statedWeights(asked))
  return statedWeights(r).some((w) => !near(w, posting.weightLbs) && !theirs.has(w))
}

// What the broker says when the weight is pushed on: the posted one, firmly.
export function weightHoldLine(posting) {
  return `This one is ${posting.weightLbs.toLocaleString('en-US')} lbs as posted, and that doesn't change.`
}

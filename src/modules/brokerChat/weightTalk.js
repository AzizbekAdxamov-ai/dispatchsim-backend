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

// Informal "9k total" is a price, while "43.5k" can still be weight.
// Mask only explicitly monetary shorthand; a pounds unit always wins so a
// mixed price-and-weight request cannot hide its actual added freight.
function weightText(value) {
  const text = String(value ?? '')
  return text.replace(THOUSANDS, (token, amount, offset) => {
    const before = text.slice(0, offset)
    const after = text.slice(offset + token.length)
    if (/^\s*(?:lbs?\b|pounds?\b)/i.test(after)) return token
    const monetary = /\$\s*$/.test(before)
      || /^\s*(?:\$|total\b|all[- ]?in\b|linehaul\b|dollars?\b|USD\b)/i.test(after)
    return monetary ? ' '.repeat(token.length) : token
  })
}

export function statedWeights(reply) {
  const text = weightText(reply)
  const out = []
  for (const m of text.matchAll(POUNDS)) out.push(Number(m[1].replace(/,/g, '')))
  for (const m of text.matchAll(THOUSANDS)) out.push(Math.round(Number(m[1]) * THOUSAND))
  return out
}

// The dispatcher asks to change the weight ("can u add 10k lbs more"): a
// change word next to a weight word or figure, or a figure that is not the
// posted weight put as a request ("can you do 50k lbs?"). A capacity or a
// weight they state ("45k capacity", "can haul 44,000 lbs") asks for nothing.
const CHANGE_ASK = /\b(?:add|more|extra|heavier|over|bump|up to)\b[^.!?]{0,25}\b(?:lbs?|pounds|weight|\d+(?:\.\d+)?\s?k)\b|\b(?:\d[\d,]*\s*(?:lbs?|pounds)|\d+(?:\.\d+)?\s?k(?:\s?lbs?)?)\s+(?:more|extra)\b/i
// "can take up to 45k lbs" says what the truck holds, not what to put on it.
const CAPACITY_UP_TO = /\b(?:take|haul|carry|handle|hold|run|pull)\w*\s+up to\b/gi
const REQUEST_CUE = /\b(?:can|could|would|will)\s+(?:you|u|ya|we|they|it)\b|\b(?:ok|okay)\b|\b(?:please|pls)\b|\b(?:how|what) about\b|\bmake it\b|\bbump\w*\b|\bactually\b|\bnow\b/i
// The reply goes along with it, or the weight is no object.
const AGREES_WEIGHT = /\b(?:isn'?t|is not|not|won'?t be|shouldn'?t be)\s+(?:an?\s+)?(?:issue|problem)\b|\bno (?:problem|issue)\b|\bcan (?:add|take|do|handle|go)\b|\b(?:sure|yes|yep|yeah|fine|works)\b/i
// "not sure", "doesn't work": the agreement word, denied.
const DENIED_AGREEMENT = /\b(?:not|never|n'?t)\s+(?:\w+\s+)?(?:sure|fine|works?)\b|\b(?:doesn'?t|don'?t|won'?t|isn'?t)\s+work\w*/gi
// The reply holds the weight as posted.
const HOLDS_WEIGHT = /\b(?:can'?t|cannot|won'?t|not able to)\s+(?:add|go|take|change|bump|do)\b|\b(?:stays?|doesn'?t change|won'?t change|as posted|is what it is)\b/i
// An accepted extra amount overrides a posted-weight reference elsewhere.
// Keep the extra amount and approval in one contrastive clause so a denial
// after "but" cannot borrow a "sure" from the preceding clause.
const EXTRA_AMOUNT = /\b(?:add(?:ing)?|more|extra|another|put on)\b[^.!?]{0,35}\b\d[\d,]*(?:\.\d+)?\s*(?:k|lbs?|pounds?)\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|lbs?|pounds?)\b[^.!?]{0,25}\b(?:more|extra)\b/i
const REFUSES_EXTRA = /\b(?:no|never|not|can'?t|cannot|won'?t|doesn'?t|don'?t|isn'?t)\b/i

const near = (w, posted) => Math.abs(w - posted) <= posted * WEIGHT_NEAR_SHARE

const SENTENCES = /(?<=[.!?])\s+/

// The reply agrees in a statement: question sentences are asked, not said
// (only their lead-in, "Sure, what's your MC?", can be a yes), and a denied
// "sure" ("Not sure, check the sheet.") is no yes.
// "Sure, what's your MC?" -> "Sure"; a question with no lead-in says nothing.
// "Is that fine, or do you need more?" is a question all the way through: its
// "fine" is asked, not said.
const QUESTION_FORM = /^\s*(?:is|are|do|does|did|can|could|will|would|should|what|which|how|who|where|when|why)\b/i
const leadIn = (question) => (question.includes(',') && !QUESTION_FORM.test(question) ? question.split(',')[0] : '')

function repliesYes(r) {
  const said = r.split(SENTENCES)
    .map((sentence) => (sentence.endsWith('?') ? leadIn(sentence) : sentence))
    .join(' ')
    .replace(DENIED_AGREEMENT, ' ')
  return AGREES_WEIGHT.test(said)
}

function acceptsExtraAmount(reply) {
  return reply.split(SENTENCES).flatMap((sentence) => sentence.split(/\bbut\b|;/i)).some((clause) => {
    const withoutPositiveNo = clause.replace(/\bno (?:problem|issue)\b/gi, ' ')
    return EXTRA_AMOUNT.test(clause) && !REFUSES_EXTRA.test(withoutPositiveNo) && repliesYes(clause)
  })
}

function asksWeightChange(asked, posting) {
  if (CHANGE_ASK.test(asked.replace(CAPACITY_UP_TO, ' '))) return true
  // The cue and the figure must share a sentence: "can you do $2,300? i have 44k capacity".
  return asked.split(SENTENCES).some((sentence) => REQUEST_CUE.test(sentence)
    && statedWeights(sentence).some((w) => !near(w, posting.weightLbs)))
}

// True when the reply agrees to a different weight, or states one the load
// does not have (and the dispatcher did not type). A reply that states the
// posted weight is not agreeing to another.
export function weightChangeAgreed(reply, { posting, text }) {
  if (posting?.weightLbs == null) return false
  const r = weightText(asciiPunct(String(reply ?? '')))
  const asked = weightText(asciiPunct(String(text ?? '')))
  const stated = statedWeights(r)
  const holdsPosted = stated.some((w) => near(w, posting.weightLbs))
  if (asksWeightChange(asked, posting)
    && (acceptsExtraAmount(r) || (!holdsPosted && repliesYes(r) && !HOLDS_WEIGHT.test(r)))) return true
  const theirs = new Set(statedWeights(asked))
  return stated.some((w) => !near(w, posting.weightLbs) && !theirs.has(w))
}

// What the broker says when the weight is pushed on: the posted one, firmly.
export function weightHoldLine(posting) {
  return `This one is ${posting.weightLbs.toLocaleString('en-US')} lbs as posted, and that doesn't change.`
}

import { asciiPunct } from '../../lib/plainText.js'

// Broker cancellation policy. Duration is a named constant because the
// default is still pending Azizbek's decision (2026-11-04).
export const BROKER_BLOCK_DAYS = 7 // Azizbek qarori 2026-11-04 — kutilmoqda
export const BLOCK_REASON_CARRIER_CANCEL = 'carrier_cancelled_agreed_load'
export const BLOCK_REASON_WAIT_NO_ETA = 'wait_no_eta' // no block; retained for audit vocabulary
export const BLOCK_REASON_ABANDONED_IN_TRANSIT = 'carrier_abandoned_in_transit' // carrier walked away from a load already on the road

// 'agreed' covers every paper stage (awaiting_email, paper_pending,
// paper_delivered): the status stays 'agreed' until the load is booked.
export const CANCELLABLE_STATUSES = Object.freeze(['agreed', 'booked'])

// What the broker says when the carrier asks for time without giving an ETA.
export const WAIT_ETA_LINE = "I can hold it briefly. What's the truck's ETA?"

// "it / this / that load / the load" -- the LOAD being cancelled. A bare
// "cancel" or "can't cover" is not enough: live T7 (Northgate) blocked a
// carrier who wrote "I cant cover that rate, can u do 3400?". The lookahead
// drops "cancel it for 3400" / "this rate" style phrases, where the object
// is a price, not the load.
const LOAD_OBJECT = String.raw`(?:it|this(?:\s+(?:one|load))?|that\s+load|the\s+load|load\s+#?\d+)\b(?!\s+(?:rate|price|number|figure|amount)\b|\s+(?:for|at)\s+\$?\d)`
// After a verb with no object: a figure or "that/the/ur rate" means a price.
const NOT_A_PRICE = String.raw`(?!\s+\$?\d|\s+(?:it|this)\s+(?:for|at)\s+\$?\d|\s+(?:that|the|ur|your|this)\s+(?:rate|price|number|figure|amount)\b)`

// WEAK phrasings also turn up in a rate haggle ("can't cover it at that
// rate"), so they count only when nothing in the message talks price.
const WEAK_CANCEL_RES = [
  new RegExp(String.raw`\bcancel(?:led|ling|ing)?\s+${LOAD_OBJECT}`, 'i'),
  new RegExp(String.raw`\bcan'?t\s+cover\s+${LOAD_OBJECT}`, 'i'),
  // "can u do 3400, otherwise find another truck" is a threat inside a haggle.
  /\bfind\s+another\s+truck\b/i,
]
// STRONG phrasings name the end of the booking itself.
const STRONG_CANCEL_RES = [
  new RegExp(String.raw`\breleas(?:e|ing)\s+${LOAD_OBJECT}`, 'i'),
  // Breakdown + "can't do/run/cover": the object may be left out here
  // because the breakdown itself says which load. [^.!?]{0,60} is the
  // longest gap seen between the two in live replies (T5, EB25, S10).
  new RegExp(String.raw`\btruck\s+(?:broke\s+down|is\s+down)\b[^.!?]{0,60}?\bcan'?t\s+(?:do|run|cover)\b(?:\s+${LOAD_OBJECT}|${NOT_A_PRICE})`, 'i'),
]

// Any sign the carrier is talking about money: a figure, a price word, "at
// that" / "for that", "too low", "less". A message with one is a haggle, never
// a weak cancel ("I can't cover it at that rate", "cancel it for that price",
// "can't cover it, too low").
//
// A bare digit is NOT a signal: "cancel load 4521" and "truck is 2 hrs away"
// are not prices. A number counts only in a price context (below).
const PRICE_WORD_RE = /\b(?:rates?|price|money|pay|paying|paid|less|low|lower|more|cheap|cheaper|below|under)\b|\b(?:at|for|with)\s+(?:that|this)\b/i
// "$3400", "3.4k".
const PRICE_SYMBOL_RE = /\$|\b\d+(?:\.\d+)?\s*k\b/i
// Hours, minutes, clock and distance units: a number with one is not money.
const NON_MONEY_UNIT = String.raw`(?:hrs?|hours?|mins?|minutes?|am|pm|mi|miles?)\b`
// A number right after a word that introduces a price ("do 3400", "at 80").
const PRICE_NUMBER_AFTER_WORD_RE = new RegExp(String.raw`\b(?:rate|price|pay|do|at|for|to)\s+\d[\d,]*(?!\d|,|\s*${NON_MONEY_UNIT})`, 'i')
// MIN_PRICE_DIGITS: a figure of three or more digits is a price unless it is
// an identifier ("load 4521", "#4521", "order 123") or has a time/distance unit.
const MIN_PRICE_DIGITS = 3
const BIG_NUMBER_RE = new RegExp(String.raw`(?<!(?:\b(?:load|id|order|ref)|#)\s*)\b\d{${MIN_PRICE_DIGITS},}\b(?!\s*${NON_MONEY_UNIT})`, 'i')
const PRICE_SIGNAL_RES = [PRICE_WORD_RE, PRICE_SYMBOL_RE, PRICE_NUMBER_AFTER_WORD_RE, BIG_NUMBER_RE]

// A clause that only imagines a cancellation, or denies one.
export const HYPOTHETICAL_RE = /\b(?:if|unless|what\s+if|should\s+i|do\s+i\s+(?:need|have)\s+to|would\s+(?:you|u|i)|in\s+case)\b/i
export const NEGATION_RE = /\b(?:don'?t|do\s+not|not|never|won'?t|didn'?t)\b/i
// Clauses split on sentence punctuation or "but". A "?" does not cancel the
// intent: "can u cancel it?" is a real request.
export const CLAUSE_SPLIT_RE = /[.;!?]|\bbut\b/i

const WAIT_RES = [
  /\bcan\s+(?:you|u)\s+wait\b/i,
  /\bwait\s+for\s+me\b/i,
  /\btruck\s+(?:is\s+)?(?:not|isn'?t)\s+working\b/i,
]
const NO_ETA_RES = [
  /\bno\s+eta\b/i,
  /\bwithout\s+an?\s+eta\b/i,
  /\bdon'?t\s+have\s+an?\s+eta\b/i,
]
// The carrier already gave a time: that is an answer, not a request to wait.
const GIVES_ETA_RE = /\beta\s+(?:is\s+|of\s+)?(?:\d|about|around|in\b)|\bready\s+by\b|\btomorrow\b|\bin\s+\d+\s*(?:hrs?|hours?|mins?|minutes?)\b/i

function saysCancel(source) {
  const priced = PRICE_SIGNAL_RES.some((re) => re.test(source))
  return source.split(CLAUSE_SPLIT_RE).some((clause) => (
    (STRONG_CANCEL_RES.some((re) => re.test(clause)) || (!priced && WEAK_CANCEL_RES.some((re) => re.test(clause))))
    && !HYPOTHETICAL_RE.test(clause)
    && !NEGATION_RE.test(clause)
  ))
}

export function cancellationIntent(text) {
  const source = asciiPunct(text)
  if (saysCancel(source)) return { kind: 'cancel', explicit: true }
  const explicit = NO_ETA_RES.some((re) => re.test(source))
  const asksWait = explicit || WAIT_RES.some((re) => re.test(source))
  if (asksWait && (explicit || !GIVES_ETA_RE.test(source))) return { kind: 'wait', explicit }
  return { kind: 'none', explicit: false }
}

export function blockUntil(from = new Date(), days = BROKER_BLOCK_DAYS) {
  const result = new Date(from)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

// The line that takes the load back when the carrier has no ETA. Stored
// verbatim as the broker's message, so releasedToAnotherTruck can find it.
export const RECLAIM_LINE = "I gave you a window and you still have no ETA. I'm giving this to another truck."
// What the broker says to any later message on a released thread: the load is
// gone, it is never offered back.
export const RELEASED_LINE = "That one's already gone to another truck. Call me if you've got a truck for something else."

// True once the broker has released the load to another truck on this thread
// (thread: { role, content } rows). Exact match: the line is written by
// insertExchange as-is and read back unchanged by listMessages.
export function releasedToAnotherTruck(thread = []) {
  return thread.some((m) => m.role === 'broker' && m.content === RECLAIM_LINE)
}

// No speaker prefix: the line is stored as the broker's message and the UI
// already shows who said it ("Marcus Oyelaran: ..." doubled the name).
export function cancellationResponse({ alreadyAskedEta = false, noEta = false } = {}) {
  if (noEta || alreadyAskedEta) return RECLAIM_LINE
  return "You booked it and now you're bailing? I just burned my shipper because of you. Don't call this desk again."
}

// What the server does with a carrier message, or null to let the broker
// model answer. brokerSaid: the broker's earlier lines in this thread.
// thread (optional, oldest first, { role, content }): lets the policy see
// whether the carrier gave an ETA after the broker asked for one.
export function cancellationDecision({ status, text, brokerSaid = [], thread = null } = {}) {
  if (!CANCELLABLE_STATUSES.includes(status)) return null
  const intent = cancellationIntent(text)
  if (intent.kind === 'cancel') return { action: 'block', line: cancellationResponse() }
  if (intent.kind === 'wait') {
    const asked = thread
      ? thread.findLastIndex((m) => m.role === 'broker' && String(m.content).includes(WAIT_ETA_LINE))
      : brokerSaid.some((line) => String(line).includes(WAIT_ETA_LINE)) ? 0 : -1
    // An ETA given since the question is an answer: asking for time again is
    // a new request, not a second wait with nothing to say.
    const etaGiven = thread && asked >= 0
      && thread.slice(asked + 1).some((m) => m.role === 'dispatcher' && GIVES_ETA_RE.test(asciiPunct(m.content)))
    if (intent.explicit || (asked >= 0 && !etaGiven)) {
      return { action: 'reclaim', line: cancellationResponse({ noEta: true }) }
    }
    return { action: 'ask_eta', line: WAIT_ETA_LINE }
  }
  return null
}

export function shouldBlock({ status, cancellationText, waitTurns = 0 } = {}) {
  return cancellationDecision({ status, text: cancellationText })?.action === 'block'
}

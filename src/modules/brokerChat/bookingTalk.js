// What the dispatcher has told the broker on the way to a booking, read by
// code: who is calling (company, MC), where the truck is and when it is
// empty, the trailer, the driver, the truck number, the email for the rate
// confirmation. The broker is TOLD the result as a fact -- it cannot look an
// MC up, so it must never say one "checks out" on its own; and the booking
// gate (brokerChat.service.js) uses the same verdict.
//
// Azizbek's decisions, 2026-10-17: the broker does not know who is calling
// until they say; a wrong or missing MC means no booking and no rate con
// (talking price is fine); before booking the broker asks, one thing at a
// time, for what is still missing; nothing already told is asked again.
//
// Newest message wins for every field. Pure: texts in, facts out.

import { asciiPunct } from '../../lib/plainText.js'
import { equipmentIn, HEAVY_LBS } from './rateTalk.js'
import { truckFacts } from './truckTalk.js'

// A pickup closer than this makes the truck's whereabouts the first thing
// to ask (also used by the prompt's load situation).
export const SOON_PICKUP_HOURS = 12
// Freight heavier than this makes the trailer the first thing to ask.
// Defined in rateTalk.js (a heavy load is also a reason to pay more).
export { HEAVY_LBS }

// -- MC -----------------------------------------------------------------

// "MC-741309", "MC 741309", "mc#741309", "mc: 741309", "MC number 741309".
// Also "our MC is 741309", "MC # is 741309", "M.C. 741309".
const MC_RE = /\bm\.?c\.?\s*(?:#|no\.?|number|:)?\s*(?:is|:)?\s*-?\s*(\d{5,7})\b/gi
// "741309 is the mc" / "... is my mc" / "... is our mc".
const MC_AFTER_RE = /\b(\d{5,7})\s+is\s+(?:the|my|our)\s+m\.?c\b/gi
// A bare number counts only when it is the WHOLE message ("741309"): a rate
// ("$4,278"), a truck number or a mileage inside a sentence is never an MC.
const BARE_MC_RE = /^\s*#?(\d{5,7})\s*$/
// "dot 1234567" / "usdot: 1234567" is not an MC, even when an "mc" follows.
const DOT_BEFORE = /\b(?:us)?dot\s*(?:#|no\.?|number|:)?\s*-?\s*$/i

function mcIn(text) {
  const src = asciiPunct(text)
  const bare = BARE_MC_RE.exec(src)
  if (bare) return bare[1]
  let found = null
  for (const m of [...src.matchAll(MC_RE), ...src.matchAll(MC_AFTER_RE)]) {
    if (DOT_BEFORE.test(src.slice(0, m.index))) continue
    found = m[1]
  }
  return found
}

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '')

// -- Company ------------------------------------------------------------

// "this is Aziz with Cedar Ridge Transport, calling about ...",
// "calling from Cedar Ridge", "Aziz here from Cedar Ridge". A "with" or
// "from" counts only after an introduction: "empty with a 53 dry van" and
// "from dallas to chicago" are not a company.
const COMPANY_RE = new RegExp(
  "\\b(?:this is|it'?s|i'?m|im|my name is|name'?s|calling|dispatch(?:er)?|speaking|here)\\b[^.!?,]{0,40}?\\b(?:with|from)\\s+"
  + "([a-z0-9&.' -]{2,60}?)(?=,|\\.|\\?|!|\\s+(?:calling|about|and|here|looking|regarding|on|for|i|we)\\b|$)"
  + "|\\bdispatch(?:er)?\\s+(?:at|for)\\s+([a-z0-9&.' -]{2,60}?)(?=,|\\.|\\?|!|\\s+(?:calling|about|and|here|looking|regarding|on|for|i|we)\\b|$)",
  'i',
)
const NOT_A_COMPANY = /^(?:a|an|the|my|our|your|you|it|this|that|them|him|her|no|one|two|three|\d)\b/i

function companyIn(text) {
  const m = COMPANY_RE.exec(asciiPunct(text))
  const name = (m?.[1] ?? m?.[2] ?? '').trim()
  if (!name || NOT_A_COMPANY.test(name)) return null
  return name
}

const SUFFIXES = /\b(?:llc|l l c|inc|incorporated|co|corp|corporation|company|ltd)\b/g
function normalCompany(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function companyMatches(said, carrierName) {
  if (!said || !carrierName) return null
  const a = normalCompany(said)
  const b = normalCompany(carrierName)
  if (a.length < 2 || b.length < 2) return null
  return a === b || a.includes(b) || b.includes(a)
}

// -- Truck, trailer, driver, email ---------------------------------------

const EMPTY_RE = /\b(?:empty|mt|available|free|ready)\b[^.;!?]{0,20}?\b(?:now|today|tonight|tomorrow|tmrw|tmr|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(?::\d{2})?\s?(?:am|pm))(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s?(?:am|pm))?/i
const LENGTH_RE = /\b(48|53)\s*(?:'|ft\b|foot\b|feet\b|(?=\s*(?:dry|van|reefer|refer|flat|step)))/i

const NAME_STOPS = new Set([
  'is', 'will', 'has', 'can', 'could', 'would', 'should', 'was', 'were', 'be', 'in', 'at', 'on', 'near', 'out', 'from', 'to',
  'with', 'the', 'a', 'an', 'and', 'for', 'needs', 'need', 'got', 'have', 'name', 'truck', 'trk', 'unit', 'tractor', 'email',
  'send', 'rc', 'ratecon', 'rate', 'then', 'who', 'that', 'it', 'i', 'we',
])
const DRIVER_RE = /\bdriver(?:'s| is|:)?\s+(?:name\s*:?\s*(?:is\s+)?)?([a-z]+(?:\s+[a-z]+)?)/gi
const TRUCK_NO_RE = /\b(?:truck|unit|trk|tractor)\s*(?:#|no\.?|number|:)?\s*([A-Z0-9][A-Z0-9-]{1,11})\b/gi
const UNIT_AFTER = /^\s*(?:ft\b|foot\b|feet\b|'|mi\b|miles?\b)/i
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

function driverNameIn(text) {
  let found = null
  for (const m of asciiPunct(text).matchAll(DRIVER_RE)) {
    const words = m[1].trim().split(/\s+/)
    if (NAME_STOPS.has(words[0].toLowerCase())) continue
    const kept = NAME_STOPS.has((words[1] ?? '').toLowerCase()) ? words.slice(0, 1) : words
    found = titleCase(kept.join(' '))
  }
  return found
}

function truckNumberIn(text) {
  const src = asciiPunct(text)
  let found = null
  for (const m of src.matchAll(TRUCK_NO_RE)) {
    if (!/\d/.test(m[1])) continue
    if (UNIT_AFTER.test(src.slice(m.index + m[0].length))) continue
    found = m[1].toUpperCase()
  }
  return found
}

// First non-null of fn(text), newest message first.
function newest(texts, fn) {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const v = fn(String(texts[i] ?? ''))
    if (v !== null && v !== undefined) return v
  }
  return null
}

// -- The facts ----------------------------------------------------------

export function bookingFacts({ texts, carrier = null, posting = null, now = new Date() }) {
  const said = (texts ?? []).map((t) => String(t ?? ''))

  const mcDigits = newest(said, mcIn)
  const carrierDigits = digitsOf(carrier?.mcNumber)
  let verdict = null
  // 'unverifiable': they said an MC but the carrier row has none to compare with.
  if (mcDigits !== null) verdict = !carrierDigits ? 'unverifiable' : digitsOf(mcDigits) === carrierDigits ? 'match' : 'mismatch'

  const company = newest(said, companyIn)
  const truck = posting ? truckFacts({ texts: said, posting, now }) : null
  const emptyAt = newest(said, (t) => EMPTY_RE.exec(asciiPunct(t))?.[0].trim() ?? null)
  const type = newest(said, equipmentIn)
  const lengthFt = newest(said, (t) => {
    const m = LENGTH_RE.exec(asciiPunct(t))
    return m ? Number(m[1]) : null
  })
  const fits = type === null ? null
    : type === posting?.equipmentType && (lengthFt === null || !posting?.equipmentLengthFt || lengthFt >= posting.equipmentLengthFt)

  const facts = {
    company,
    companyMatches: companyMatches(company, carrier?.name),
    mc: { said: mcDigits, verdict },
    truck,
    emptyAt,
    trailer: { type, lengthFt, fits },
    driverName: newest(said, driverNameIn),
    truckNumber: newest(said, truckNumberIn),
    email: newest(said, (t) => EMAIL_RE.exec(t)?.[0].toLowerCase() ?? null),
  }
  facts.missing = missingFor(facts, posting, now)
  return facts
}

// What the broker still needs, in the order a broker would ask: who they are
// first; then the truck or the trailer first depending on the load (a
// pickup within hours makes the truck's whereabouts the question, heavy
// freight or an open deck makes the trailer the question); then the
// paperwork details.
function missingFor(f, posting, now) {
  const out = []
  if (f.mc.said === null) out.push('mc')
  if (f.company === null) out.push('company')

  const pickupMs = posting?.pickupAt ? new Date(posting.pickupAt).getTime() : NaN
  const soon = Number.isFinite(pickupMs) && pickupMs > now.getTime() && (pickupMs - now.getTime()) / 3600e3 < SOON_PICKUP_HOURS
  const trailerFirst = !soon && posting && (['flatbed', 'step-deck'].includes(posting.equipmentType) || posting.weightLbs > HEAVY_LBS)
  const where = []
  if (f.truck === null) where.push('location')
  if (f.emptyAt === null) where.push('emptyAt')
  const trailer = f.trailer.type === null || f.trailer.lengthFt === null ? ['trailer'] : []
  out.push(...(trailerFirst ? [...trailer, ...where] : [...where, ...trailer]))

  if (f.driverName === null) out.push('driverName')
  if (f.truckNumber === null) out.push('truckNumber')
  if (f.email === null) out.push('email')
  return out
}

// -- Reading a broker reply ------------------------------------------------

// The reply tells the carrier it is booked / the paper is coming.
export const SAYS_BOOKED = /\b(?:booked|you'?re (?:all )?set|it'?s yours|load is yours|sending (?:over )?(?:the )?(?:rate ?con|rc|confirmation)|rate ?con (?:is )?(?:on (?:its|the) way|coming))\b/i
// A condition before the word ("if you share your MC, we can get it booked")
// makes it a promise of what happens later, not a statement that it is booked.
const BOOK_CONDITION = /\b(?:if|once|as soon as|when|after|until|unless|provided)\b/i
// "send me your MC and we'll get it booked": the MC is asked for, booking follows it.
const BOOK_AFTER_ASK = /\b(?:get|have)\s+(?:it|you|this|that)\s+(?:all\s+)?$/i
const SAYS_BOOKED_EACH = new RegExp(SAYS_BOOKED.source, 'gi')
export function saysBooked(reply) {
  return asciiPunct(reply).split(SENTENCE_SPLIT).some((sentence) => {
    const asks = mcQuestion(sentence)
    return [...sentence.matchAll(SAYS_BOOKED_EACH)].some((m) => {
      const before = sentence.slice(0, m.index)
      return !BOOK_CONDITION.test(before) && !(asks && BOOK_AFTER_ASK.test(before))
    })
  })
}

// The broker says the MC does not come up. Tested on asciiPunct text.
export const MC_REJECT = /(?:doesn'?t|does not|didn'?t|did not) (?:come up|match|show(?: up)?|pull up)|(?:isn'?t|is not|not) (?:coming up|showing(?: up)?|matching|pulling up)|not finding|(?:can'?t|cannot|couldn'?t) find|no record|wrong mc/i

// The reply asks for the MC (it names it AND asks or requests it).
const MC_WORD = /\bmc\b|motor carrier|docket/i
const ASKING = /\?|\b(?:need|give me|send me|what'?s|what is|got an?)\b/i
export function asksMc(reply) {
  const text = asciiPunct(reply)
  return MC_WORD.test(text) && ASKING.test(text)
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/
// Some sentence of the reply both names the MC and asks for it: "Your MC
// checks out. Where's the truck?" asks for nothing about the MC, which
// asksMc (whole reply) would say it does.
export function mcQuestion(reply) {
  return asciiPunct(String(reply ?? '')).split(SENTENCE_SPLIT).some((s) => MC_WORD.test(s) && ASKING.test(s))
}

// A question about the paperwork details (driver, truck number, email) --
// what the broker asks for only once the MC checks out.
const PAPER_ASK = /\b(?:driver|truck (?:number|#)|unit (?:number|#)|e-?mail)\b/i
export function asksPaperDetails(reply) {
  return asciiPunct(String(reply ?? '')).split(SENTENCE_SPLIT).some((s) => s.includes('?') && PAPER_ASK.test(s))
}

// The dispatcher is moving to book: "book it", "I'll take it", the driver, the
// truck number or the email for the rate con. The MC is asked for again only then.
export const MOVES_TO_BOOK = /\b(?:book (?:it|me|this)|i'?ll take it|we'?ll take it|lock (?:it|this) in|send (?:me )?(?:the )?(?:rc|rate ?con|confirmation)|let'?s do it|deal|works for me)\b|\bdriver(?:'s| is)?\s+[a-z]|\btruck\s*(?:#|number|no)|@/i

// -- The booking gate -------------------------------------------------------

// null when the MC checks out; otherwise { reason, message } where message is
// the broker's own sentence (shown to the dispatcher as it is -- never a
// silent failure).
export function carrierNotVerified({ booking, contactName }) {
  if (booking?.mc?.verdict === 'match') return null
  const who = contactName || 'The broker'
  if (booking?.mc?.verdict === 'mismatch') {
    return {
      reason: 'mc-mismatch',
      message: `${who}: "That MC doesn't come up on my end -- I can't send paper until I have the right one."`,
    }
  }
  if (booking?.mc?.verdict === 'unverifiable') {
    return {
      reason: 'mc-unverifiable',
      message: `${who}: "I can't check that MC on my end right now -- I can't send paper until I can."`,
    }
  }
  return { reason: 'mc-missing', message: `${who}: "I still need your MC before I send the rate con."` }
}

// -- A booking the broker has no record of ------------------------------------

// A denial word. (Moved here from scripts/evalCases.js, which imports it.)
export const NEGATION = /\b(no|nope|nah|not|never|didn'?t|don'?t|isn'?t|wasn'?t|haven'?t|nothing)\b/i
// The reply without its negated sentences: a denial is not a confirmation.
export const unnegated = (r) => r.split(/(?<=[.!?])\s+/).filter((x) => !NEGATION.test(x)).join(' ')

// The dispatcher says the load is already booked, or that someone on the
// broker's side gave it to them ("i already booked this with ur guy mike",
// EB17). The chat has no such booking and no such person.
const CLAIMS_EARLIER_BOOKING = /\b(?:already|just)\s+(?:booked\s+(?:it|this|that|with|w|through|thru)|got (?:it|this|that) booked|had (?:it|this) booked|locked (?:it|this) in)\b|\bbooked (?:it|this|that) (?:with|through)\b|\b(?:ur|your) (?:guy|girl|colleague|coworker|partner|buddy|rep|other (?:guy|broker|rep))\b[^.!?]{0,30}\b(?:booked|gave|promised|locked)\b/i
// The reply takes that as settled.
const CONFIRMS_BOOKING = /\b(?:good|glad|great) to hear\b|\blocked in\b|\byou'?re (?:all )?set\b|\ball set\b|\bconfirmed\b|^\s*(?:yes|yeah|yep|right|correct|perfect)\b/i
// Other ways to say "I have no record" that NEGATION does not carry.
const NO_RECORD = /\b(?:can'?t|cannot|couldn'?t|doesn'?t|does not|unaware)\b/i
// A reply that is one of the other safe lines (holdRateLine, PAYMENT_TERMS_LINE)
// goes along with nothing. Only their exact wording counts: a bare "stays"
// is also how a phantom booking is confirmed ("Ok, he stays on it.").
const HOLDS_POSITION = /\ball-in is where this one stays\b|\baccounting'?s side\b/i

// What the broker says when a booking it has no record of is claimed.
export const NO_BOOKING_LINE = "I don't have that on my end — no booking here yet."

// True when the dispatcher claims an earlier booking, this conversation has
// none (`bookedHere`: it is agreed or booked), and the reply goes along with
// it -- confirms it, or says nothing against it.
export function confirmsUnknownBooking(reply, { text, bookedHere = false }) {
  if (bookedHere || !CLAIMS_EARLIER_BOOKING.test(asciiPunct(String(text ?? '')))) return false
  const r = asciiPunct(String(reply ?? ''))
  return CONFIRMS_BOOKING.test(unnegated(r)) || !(NEGATION.test(r) || NO_RECORD.test(r) || HOLDS_POSITION.test(r))
}

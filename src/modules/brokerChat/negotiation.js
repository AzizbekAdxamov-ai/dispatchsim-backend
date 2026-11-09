// Financial decisions are server facts. The model supplies a voice, never a price.
import { asciiPunct } from '../../lib/plainText.js'
import { ceilingFor } from './ratePolicy.js'
import { rateReasons, REASON_WORDS } from './rateTalk.js'
import { saysBooked, mcQuestion } from './bookingTalk.js'
import { rateQuote, quoteText, SPLIT_RATE } from './rateQuote.js'
import { proposesRebroker, ONE_CARRIER_REPLY } from './carrierPolicy.js'
import { brokerStyle, voiceKey } from './brokerStyle.js'

const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi
const MONEY = '(?:\\$\\s*)?(\\d+(?:\\.\\d+)?[kK]|(?:\\d{1,3}(?:,\\d{3})+|\\d{3,5})(?:\\.00)?)(?:\\s*\\$)?'
const OFFER = new RegExp(`\\b(?:need|want|asking for|seeing (?:this )?lane around|(?:can|could) (?:you|u)(?: meet (?:me|us) at| do)?|how about|what about|offer|pay|take (?:it|this|the load) for|run (?:it|this) for|do (?:it|this) for)\\s+${MONEY}(?![\\d.,])`, 'gi')
const ACCEPT_AT = new RegExp(`\\b(?:accept|agree (?:on|to)|take (?:it|this|the load) (?:at|for)|book (?:it|this|the load) (?:at|for)|works? (?:at|for)|if (?:you|u) can do|i can (?:cover|take) (?:it|this|the load)?\\s*at)\\s+${MONEY}(?![\\d.,])`, 'gi')
const AMOUNT_FIRST = new RegExp(`^\\s*(?:(?:aight|alright|all right|okay|ok|yeah|yes)[, ]+)?${MONEY}\\s*(?:(?:all[- ]?in|total(?: including fuel)?|linehaul(?: plus fuel)?)\\s*)?(?:works(?: for (?:me|us))?|is (?:fine|good)|(?:is )?accepted|(?:is )?agreed)(?:[, ]+(?:bro(?:ther)?|man))?(?:[, ]+let'?s run it)?[.!]?\\s*$`, 'i')
// "yes $3500 all in, book it" / "3500 works book it" / "ok 3500 deal": an amount
// plus a booking word, with no "at" to carry it. It confirms the broker's own
// quote; a higher figure is only an ask. At least one accept word is required.
const AMOUNT_BOOK = new RegExp(`^\\s*(?:(?:ok(?:ay)?|yes|yeah|alright)[, ]+)?${MONEY}\\s*(?:all[- ]?in|total)?[, ]*(?:works|is fine|deal|agreed)?[, ]*(?:(?:let'?s )?book it|deal|let'?s do it|send (?:the )?(?:rc|rate con))[.!]?\\s*$`, 'i')
// An amount and a booking word that no rule above could place.
const BOOK_WORD_RE = /\b(?:book it|deal|works|let'?s do it)\b/i
// Cancelling the thing under discussion. Not a hold: nothing is paused, it is
// dropped. "cancel it for 3400" names a price, not the load, and stays a haggle.
const CANCEL_RE = /\b(?:cancel|call off|scrap)\w*\s+(?:it|this|that|the (?:load|deal|booking|rate\s*con(?:firmation)?|rc))\b(?!\s+(?:for|at)\s+\$?\d)|^\s*cancel[.!]?\s*$/i
export const NOT_BOOKED_CANCEL_LINE = "No problem, nothing's booked on this one. Want something else?"
export const AGREEMENT_DROPPED_LINE = "Okay, I'm pulling the rate con. Nothing's booked."
// Intents that clear a recipient already on the conversation.
const WITHDRAWING_INTENTS = Object.freeze(['hold', 'cancel'])
const TRAILING_SEPARATORS = /[,\s]+$/
// "3500 book it, send the rate con to a@b.com": the instruction leaves with the
// address, or its verb would stay behind and break the booking phrase.
const EMAIL_INSTRUCTION = new RegExp(
  String.raw`(?:[,;]\s*|\s+)(?:and\s+)?(?:please\s+)?(?:(?:send|email|put)(?:\s+(?:it|the\s+(?:rate\s*con(?:firmation)?|rc|paperwork)))?(?:\s+(?:to|on))?|(?:my|our)\s+e-?mail\s*(?:is|:)|e-?mail\s*(?:is|:)?|rc\s+to)\s+${EMAIL.source}`,
  'gi')
export const confirmBookLine = (quoted) => `${quoted} - we good to book?`
const ACCEPT = /^(?:(?:ok(?:ay)?|yes|great|thanks)[,!. ]+)*(?:i(?:'ll| will)|we(?:'ll| will)) take (?:it|this|the load)[.!]?\s*$|^(?:(?:ok(?:ay)?|yes)[,!. ]+)*(?:deal|agreed|book it|lets? do it|it'?s fine|that'?s fine|send (?:the )?(?:rc|rate con)|confirmed|sounds good|(?:that(?: rate)?|the rate|your rate|your offer) works(?: for (?:me|us))?|i accept(?: your (?:rate|offer))?)[.!]?\s*$/i
const NATURAL_ACCEPT = /^(?:ok(?:ay)?\s+)?(?:let'?s book it|let'?s do it|the rate works(?:\s+we can book it)?|works for me|that works|it'?s fine|that'?s fine|deal|send (?:the )?(?:rc|rate con)|confirmed|sounds good(?:,?\s+book it)?|we(?:'ll| will) take it|i(?:'ll| will) take it)[.!]?$/i
const HOLD = /\b(?:hold (?:off|up)|on hold|not ready|don't (?:book|send|issue|confirm)|do not (?:book|send|issue|confirm)|not (?:book|confirm|accept)(?:ing|ed)? yet|before (?:we|i) (?:book|confirm)|let me (?:check|confirm|verify)|gotta check (?:with )?(?:my|our|the) driver|wait for (?:my|our) confirmation|release (?:it|this|the load))\b/i
const WALK = /\b(?:i(?:'ll| will) pass|we(?:'ll| will) pass|pass on (?:it|this)|walk away|find another (?:truck|carrier))\b/i
const MORE = /\b(?:do better|too light|need more|pay more|(?:to{1,2}|kinda) low|too cheap|more money|bump (?:it|the rate)|add (?:a )?(?:little|litle)(?: bit)?|what(?:'s| is) your best|work (?:on|with me on) (?:the |ur |your )?rate|(?:come on,?\s+)?(?:a\s+)?(?:little|lil|litle)(?:\s+bit)?\s+more(?=\s*(?:[?.!,]|$|pls\b|please\b|on (?:the |ur |your )?rate\b|money\b)))\b/i
// A negation only governs the words after the last of these: in "I can't cover
// that rate, can u do 8975" the comma ends the refusal, so the ask still counts.
const NEGATION_SCOPE_BOUNDARY = /,|\bbut\b|\bso\b/gi
// "I can't do 7300" refuses a price without naming a new one: a push, no amount.
// The figure must not be a unit (hours, miles, lbs).
const REJECT_PRICE = new RegExp(`\\b(?:can't|cant|cannot|won't|wont)\\s+(?:do|take it for|run it for)\\s+${MONEY}(?![\\d.,]|\\s*(?:hrs?|hours?|mi|miles?|lbs?)\\b)`, 'i')
const QUOTED = /["“][^"”]*["”]|(?<!\w)'[^'\n]{2,}'(?!\w)/g
// A message the dispatcher wrapped entirely in quotes is still their own words;
// only a quotation inside a longer message is an example.
const WHOLE_QUOTED = /^\s*"([^"]+)"\s*[.!?]?\s*$/
// A price with no verb ("$5,000 all in", "4900?") is an offer only while the
// negotiation is open, only for a figure near the posted rate, and only when
// nothing around it says the number is something else (an MC, a truck, a time).
// Known residual risk: "paid 4000 for tires" with a rate near 4000 reads as an offer.
const BARE_RATE_MIN_SHARE = 0.5
const BARE_RATE_MAX_SHARE = 2
const BARE_AMOUNT = new RegExp(`(?<![\w#.,])${MONEY}(?![\w.%:/]|[.,]\d)`, 'gi')
const AMOUNT_UNIT_TAIL = /^\s*(?:[-/]\s*\d|(?:lbs?|pounds?|miles?|mi|ft|feet|gal|hours?|hrs?|per|\/|%|am|pm)\b)/i
const BARE_LABEL_BEFORE = /\b(?:mc|dot|truck|trailer|unit|tractor|zip|ref|po|pin|load|order|phone|pickup|pu|delivery|del|appt|appointment|eta|by|until)\s*(?:#|no\.?|number)?\s*:?\s*(?:at\s+)?$|#\s*$/i
// "8100 to low": a judgement of the price, not an ask for it.
const BARE_JUDGED_TAIL = /^\s*(?:is\s+)?(?:(?:to{1,2}|too|kinda|so)\s+)?(?:low|light|cheap|small)\b/i
const BARE_TIME_TAIL = /^\s*(?:central|ct|cst|cdt|est|am|pm|hrs?)\b/i
// The dispatcher's reply to the broker's "total or linehaul plus fuel?".
const BASIS_ANSWER_TOTAL = /^\s*(?:(?:it'?s|its|that'?s|thats|the)\s+)?(?:total|all[- ]?in)(?:\s+(?:including|incl\.?|with)\s+fuel)?[.!]?\s*$/i
const BASIS_ANSWER_LINEHAUL = /^\s*(?:(?:it'?s|its|that'?s|thats)\s+)?linehaul(?:\s+plus\s+(?:the\s+)?fuel)?[.!]?\s*$/i
const BASIS_QUESTION = /\btotal\b[^?]*\blinehaul\b[^?]*\?|\blinehaul\b[^?]*\btotal\b[^?]*\?/i
const HYPOTHETICAL = /\b(?:if|unless|hypothetically|example|suppose|said|quoted|asks?|asking whether|what if|would you accept)\b/i
const NEGATIVE = /\b(?:not|never|can't|cannot|won't|don't|didn't|do not|isn't|is not|haven't)\b/i
// The reason negotiationReplyProblem gives for any misquoted price; the service keys its server-line fallback on it.
export const RATE_MISS_REASON = 'offered a rate other than the authoritative decision'
const amountValue = (token) => {
  const value = Number(token.replaceAll(',', '').replace(/k$/i, '')) * (/k$/i.test(token) ? 1000 : 1)
  return Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value
}
const LETS_OFFER = new RegExp(`^\\s*(?:(?:okay|ok|alright|aight)[, ]+)?let'?s\\s+${MONEY}\\s*$`, 'i')
// The "for example" misspellings are not sloppy reading: the dispatcher
// typos the word and the amount is real either way (live 2026-11-05: "can
// add some money for exapmle 3700" was read as small talk, and the offer
// was never raised).
const EXAMPLE_WORD = '(?:example|exaple|exapmle|exmaple|exampel)'
const EXAMPLE_OFFER = new RegExp(`\\b(?:can|could)(?:\\s+(?:you|u|we|sir))?\\s+add (?:more|some money)[^;!?]*?\\bfor ${EXAMPLE_WORD}\\s+${MONEY}(?![\\w.,])`, 'gi')
const REPLY_MONEY = /(?<![\w\d])(?:\$\s*(\d+(?:,\d{3})*(?:\.\d+)?k?)|(\d+(?:\.\d+)?k|\d{1,3}(?:,\d{3})+|\d{3,5})(?:\.00)?)(?![\w\d])/gi

// Azizbek qarori 2026-11-04 — the negotiation ladder uses named shares so
// the broker's movement is stable when the posting pool changes.
export const STEP_1_SHARE = 0.35
export const STEP_2_SHARE = 0.30
// Azizbek qarori 2026-11-04 — carrier reasons are verified against posting facts.
const KEY_INTENTS = Object.freeze({
  ask_room: /\b(?:what(?:'s| is) the best|what do (?:you|u) have(?: in it)?|how much (?:room|u|you)\b[^.!?]{0,30}\b(?:got|have|in|on)\b|target rate|where do we need to be|approval for|check with (?:your )?customer)\b/i,
  push: /\b(?:come up on the rate|rate is too light|(?:we(?:'|)re|we are) not going to move it|(?:we(?:'|)re|we are) not gonna move it|need to be at|looking for)\b/i,
  close_at: /\b(?:if you can do|i can cover .*? at|i can take .*? at)\s+\$?\s*[\d,.]+\s*(?:k)?\b/i,
  position: /\b(?:truck empty nearby|truck is already in position|be at pickup on time)\b/i,
  service: /\b(?:clean truck|reliable driver|strong communication(?: and tracking)?)\b/i,
  market: /\b(?:seeing this lane|market is stronger|limited capacity)\b/i,
  reload: /\b(?:reloads?.*weak|delivery area.*tough.*reloads?)\b/i,
  deadhead: /\b(?:deadhead|empty run)\b/i,
  tight_window: /\b(?:appointment times.*tight|strict appointment)\b/i,
  terms: /\b(?:detention|layover|driver assist|lumper|extra stops)\b/i,
  commodity: /\b(?:commodity and weight|linehaul plus fsc|commodity and lbs|commodity.*lbs)\b/i,
  // Questions ABOUT the load (miles incl. deadhead, FCFS or appointment) --
  // facts to answer, not a rate push. Live #212/#214 (EB27, EB28) took a
  // raise from "fcfs or appt?" (2,492 -> 2,667).
  facts_question: /\b(?:total (?:miles|mileage)(?: including| incl\.?| with| w\/)?(?: the)? (?:deadhead|dh)\b|how (?:many|much) (?:deadhead|dh|empty)\b|fcfs or appt|appt or fcfs|fcfs\s*\?|(?:pickup|pu) and (?:delivery|del) (?:appointments|appts|times)\b|is (?:it|this) fcfs\b)/i,
  weak_push: /\b(?:please add \$?\s*\d+|really need more money|pls add .*?\bneed it)\b/i,
})

function keyIntent(src) {
  if (KEY_INTENTS.ask_room.test(src)) return { kind: 'ask_room' }
  const factsQuestion = src.match(KEY_INTENTS.facts_question)
  if (factsQuestion) return { kind: 'question', topic: /dead|dh|mile|empty/i.test(factsQuestion[0]) ? 'deadhead' : 'appointments' }
  if (KEY_INTENTS.push.test(src)) return { kind: 'push' }
  if (KEY_INTENTS.close_at.test(src)) return { kind: 'close_at' }
  if (KEY_INTENTS.position.test(src)) return { kind: 'push', reason: 'position' }
  if (KEY_INTENTS.service.test(src)) return { kind: 'push', reason: 'service' }
  if (KEY_INTENTS.market.test(src)) return { kind: 'push', reason: 'market' }
  if (KEY_INTENTS.reload.test(src)) return { kind: 'push', reason: 'reload' }
  if (KEY_INTENTS.deadhead.test(src)) return { kind: 'push', reason: 'deadhead' }
  if (KEY_INTENTS.tight_window.test(src)) return { kind: 'push', reason: 'tight-window' }
  if (KEY_INTENTS.terms.test(src)) return { kind: 'terms' }
  if (KEY_INTENTS.commodity.test(src)) return { kind: 'commodity' }
  if (KEY_INTENTS.weak_push.test(src)) return { kind: 'push' }
  return null
}

function addsFuelToTotal(text, totals) {
  // Read the relation between monetary references before splitting "and".
  // The same component values are safe in a sum from linehaul, but not
  // when the base of that sum is already the complete freight payment.
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    const amounts = [...sentence.matchAll(REPLY_MONEY)]
    for (let index = 0; index < amounts.length; index += 1) {
      const current = amounts[index]
      if (!totals.includes(amountValue(current[1] ?? current[2]))) continue
      const next = amounts[index + 1]
      const relation = sentence.slice(current.index + current[0].length, next?.index ?? sentence.length)
      const component = next ? sentence.slice(next.index + next[0].length, amounts[index + 2]?.index ?? sentence.length) : ''
      const negated = /\b(?:no|not|never|without|isn't|is not)\b/i.test(relation)
      const sum = /\b(?:plus|additional|extra|excluding|before)\b|\+/i.test(relation)
        || (/\band\b/i.test(relation) && /\bon top\b|\bextra\b|\badditional\b/i.test(component))
      const fuel = /\bfuel(?: surcharge)?\b/i.test(`${relation} ${component}`)
      if (!negated && sum && fuel) return true
    }
  }
  return false
}

function clarifiesRequestedBasis(text, decision) {
  const requested = decision.intent.requestedAmountUsd
  const fuel = decision.rateQuote?.fuelSurchargeUsd
  // A confirmation preface can introduce a question, not an acceptance.
  // Strip only that fixed discourse marker before validating the whole question.
  const question = text.trim().replace(/^just to (?:confirm|clarify),?\s*/i, '')
  if (decision.intent.kind !== 'ambiguous_rate' || !Number.isSafeInteger(requested) || !Number.isSafeInteger(fuel)
    // Whole interrogative, attributed to the carrier, comparing the two bases.
    // This checks structure and financial references, not one exact phrasing.
    || !/^(?:do|does|did|are|is|was|were|can|could|would|what|which)\b[^.!?;]*\?\s*$/i.test(question)
    || !/\b(?:you|your|that)\b/i.test(question) || !/\bor\b/i.test(question)
    || /\b(?:confirm|book|accept|agree|agreed|deal|send|issue|pay|offer|approved|locked)\b/i.test(question)
    || /\b(?:i|we|my|our|us)\b/i.test(question)
    || !/\b(?:total|all[- ]?in)\b/i.test(question) || !/\blinehaul\b/i.test(question)) return false
  const amounts = [...text.matchAll(REPLY_MONEY)]
  return amounts.every((match, index) => {
    const amount = amountValue(match[1] ?? match[2])
    if (amount === requested) return true
    const before = text.slice(index ? amounts[index - 1].index + amounts[index - 1][0].length : 0, match.index)
    const after = text.slice(match.index + match[0].length, amounts[index + 1]?.index ?? text.length)
    if (amount === fuel) return /^\s*(?:for\s+)?fuel(?: surcharge)?\b/i.test(after)
      || /\bfuel(?: surcharge)?\s*(?:is|:|of|at)?\s*$/i.test(before)
    return amount === requested + fuel && (/^\s*total\b/i.test(after) || /\btotal\s*(?:is|:|of|at)?\s*$/i.test(before))
  })
}

function intentText(raw) {
  const src = asciiPunct(String(raw ?? '')).replace(WHOLE_QUOTED, '$1')
  const normalize = (part) => part.replace(/\b(dont|didnt|cant|wont|isnt|havent|hasnt|wasnt|werent|couldnt|wouldnt|shouldnt)\b/gi,
    (word) => `${word.slice(0, -1)}'t`)
  let result = '', position = 0
  for (const match of src.matchAll(EMAIL)) {
    result += normalize(src.slice(position, match.index)) + match[0]
    position = match.index + match[0].length
  }
  return result + normalize(src.slice(position))
}

// True when a negation sits in the stretch of the clause that leads into this
// match: from the last scope boundary before it to the end of the match.
function negatedLocally(clause, match) {
  let start = 0
  for (const boundary of clause.slice(0, match.index).matchAll(NEGATION_SCOPE_BOUNDARY)) start = boundary.index + boundary[0].length
  return NEGATIVE.test(clause.slice(start, match.index + match[0].length))
}

// Mask addresses while splitting so their dots cannot detach a negation or condition.
// Recipient authorization is checked once, per clause, before every intent branch.
function authorizedRecipient(src) {
  const addresses = []
  const masked = src.replace(QUOTED, ' ').replace(EMAIL, (email) => {
    addresses.push(email.toLowerCase())
    return `EMAILTOKEN${addresses.length - 1}`
  })
  const authorized = []
  let useOwnEmail = false
  // Check dependencies before splitting coordinated clauses: "after I
  // confirm and approve, send..." is still conditional in its entirety.
  const clauses = masked.split(/(?<=[.!?;])\s+|\n+/).flatMap((sentence) => {
    const pendingApproval = /\b(?:after|when|once|until)\b[^.!?;]{0,80}\b(?:confirm\w*|approv\w*|verif\w*|accept\w*|agree\w*|check\w*)\b/i.test(sentence)
    return pendingApproval ? [] : sentence.split(/\b(?:but|however|and)\b/i)
  })
  for (const clause of clauses) {
    if (NEGATIVE.test(clause) || HYPOTHETICAL.test(clause)) continue
    const own = /^(?:(?:yes|okay|ok)[,.! ]+)?(?:please )?(?:use|send (?:it|the (?:rate )?confirmation|the rate con) to) (?:my|our) (?:(?:saved|company|carrier|account|login) )?e-?mail[.!\s]*$/i.test(clause.trim())
    if (own) useOwnEmail = true
    const tokens = [...clause.matchAll(/EMAILTOKEN(\d+)/g)]
    if (tokens.length !== 1) continue
    const emailOnly = clause.replace(/EMAILTOKEN\d+/, '').replace(/[.!\s]/g, '') === ''
    const instruction = /\b(?:my|our) (?:(?:company|carrier|contact|dispatch) )?e-?mail\s*(?:is|:)?\s+EMAILTOKEN\d+/i.test(clause)
      || /\b(?:send|email)\b[^.!?]{0,65}\bto\s+EMAILTOKEN\d+/i.test(clause)
      || /\b(?:use|recipient(?: is|:)?)\s+EMAILTOKEN\d+/i.test(clause)
      // Desk shorthand: "rc to x@y", "send rc x@y", "email is x@y". The
      // last is the carrier's own only when no third party owns the email.
      || /\b(?:rc|rate ?con(?:firmation)?|ratecon|paperwork)\s+to\s+EMAILTOKEN\d+/i.test(clause)
      || /\bsend\s+(?:the\s+|over\s+(?:the\s+)?)?(?:rc|rate ?con(?:firmation)?|ratecon|paperwork)\s+(?:over\s+)?(?:to\s+)?EMAILTOKEN\d+/i.test(clause)
      || /(?<!\b(?:shipper|receiver|consignee|broker|his|her|their)(?:'s)?\s+(?:\w+\s+)?)\be-?mail\s*(?:is|:)\s+EMAILTOKEN\d+/i.test(clause)
      || /\bput\s+(?:(?:it|the (?:rate confirmation|rate con|ratecon|paperwork))\s+(?:on|to)\s+EMAILTOKEN\d+|EMAILTOKEN\d+\s+on\s+(?:the\s+)?(?:rate confirmation|rate con|ratecon|paperwork))\b/i.test(clause)
    const question = /\?/.test(clause) && !/\b(?:send|email)\b[^.!?]{0,65}\bto\s+EMAILTOKEN\d+/i.test(clause)
    if ((emailOnly || instruction) && !question) authorized.push(addresses[Number(tokens[0][1])])
  }
  const emails = [...new Set(authorized)]
  return emails.length > 1 ? { emails: [], useOwnEmail: false } : { emails, useOwnEmail }
}

// The recipient the dispatcher last authorised in an earlier message. An email
// given before the rate was agreed is still the one for the paper. Newest
// first, and the newest message that names an email settles it: a retraction
// ("don't send it to a@b.com") or a conditional leaves nobody, it does not
// revive an older address. A hold or cancel also clears it (the repository
// clears the recipient on those), so nothing older may come back.
export function lastAuthorizedEmail(texts) {
  for (const text of [...(texts ?? [])].reverse()) {
    const plain = intentText(text)
    if (new RegExp(EMAIL.source, 'i').test(plain)) {
      const { emails } = authorizedRecipient(plain)
      return emails.length === 1 ? emails[0] : null
    }
    if (WITHDRAWING_INTENTS.includes(chatIntent(text).kind)) return null
  }
  return null
}

export function chatIntent(raw, rateSource = null, { openNegotiation = false, pendingBasisUsd = null } = {}) {
  const src = intentText(raw).replace(/(\b(?:can|could)(?:\s+(?:you|u|we|sir))?)\s*(add (?:more|some money))\.\s*(?=[^;!?]*\bfor (?:example|exaple|exapmle|exmaple|exampel)\b)/gi, '$1 $2, ')
  // A mixed price acceptance/email cannot authorize a prohibited handoff.
  if (proposesRebroker(src)) return { kind: 'rebroker' }
  if (NATURAL_ACCEPT.test(src) && !HYPOTHETICAL.test(src) && !NEGATIVE.test(src)) return { kind: 'accept' }
  // Key phrases are classified before amount parsing, while preserving the
  // amount parser for offer/accept decisions below.
  const keyed = keyIntent(src)
  // Market comparisons in dollars per mile are not total load prices.
  // Remove only the comparison so another clause can still request an all-in rate.
  const amountSrc = src.replace(/\$?\d+\.\d{1,2}\s*(?:\/\s*mi\b|(?:a|per)\s+mile\b)/gi, ' ')
    .replace(/(?<![\d,])\$?[0-9]\.[0-9]{1,2}\b/g, ' ')
  if (keyed?.kind === 'close_at' && /\b(?:might|maybe|probably)\b/i.test(src)) return { kind: 'talk' }
  const closeMatch = amountSrc.match(/\b(?:if (?:you|u) can do|i can (?:cover|take) (?:it|this|the load)?(?:\s+right now)?\s+at)\s+\$?\s*([\d,.]+k?)\b/i)
  if (closeMatch) return { kind: 'accept_amount', rateUsd: amountValue(closeMatch[1]) }
  if (keyed?.reason === 'market') {
    const marketAmount = amountSrc.match(/\$?\s*([\d]+(?:\.\d+)?k?)\b/i)
    if (marketAmount) return { kind: 'offer', rateUsd: amountValue(marketAmount[1]), reason: 'market' }
  }
  if (keyed && keyed.kind !== 'push' && !new RegExp(MONEY, 'i').test(src)) return keyed
  // Quoted or hypothetical hold examples do not withdraw a real agreement.
  const activeClauses = src.replace(QUOTED, ' ').replace(EMAIL, ' ').split(/[;!?\n]|\.(?!\d)/).filter((clause) => !HYPOTHETICAL.test(clause))
  // Only a negation governing this instruction cancels it. An earlier
  // "didn't say book it" or "not sure" cannot erase a later active hold.
  const denied = /\b(?:don't|do not|didn't|did not|won't|will not|can't|cannot|not|never)\s+(?:(?:want|intend|plan|mean|need)\s+to\s+|(?:say|ask|tell)\s+(?:(?:you|them)\s+)?(?:to\s+)?)?$/i
  const active = (clause, matches) => matches.some((match) => !denied.test(clause.slice(0, match.index)))
  // Cancel is read before hold: "cancel it" used to be a hold, and the broker
  // answered that the load was "cancelled and on hold".
  if (activeClauses.some((clause) => active(clause, [...clause.matchAll(new RegExp(CANCEL_RE.source, 'gi'))]))) return { kind: 'cancel' }
  if (activeClauses.some((clause) => active(clause, [...clause.matchAll(new RegExp(HOLD.source, 'gi')),
    ...clause.matchAll(/\b(?:reject|decline) (?:your |the )?(?:rate|offer|load)\b/gi)]) || /^\s*(?:stop|hold|wait)[.!]?\s*$/i.test(clause))) return { kind: 'hold' }
  const { emails, useOwnEmail } = authorizedRecipient(src)
  // Quotes, negated intentions and conditional examples are never a handshake.
  const clauses = amountSrc.replace(QUOTED, ' ').replace(EMAIL_INSTRUCTION, ' ').replace(EMAIL, ' ').split(/[;!?\n]|\.(?!\d)/)
  const amounts = []
  const basisHints = []
  const addAmount = (token, clause) => {
    amounts.push(amountValue(token))
    basisHints.push({ total: /\b(?:all[- ]?in|total|including fuel|fuel included)\b/i.test(clause),
      linehaul: /\blinehaul\b|\bplus (?:the )?fuel\b|\+\s*fuel\b/i.test(clause) })
  }
  let acceptsAmount = false
  let confirmsOffer = false
  const bareCandidates = []
  for (const clause of clauses) {
    // A concrete counter introduced with "for example" is a request, not a
    // hypothetical story. Preserve every other conditional/quotation veto.
    const concreteExample = [...clause.matchAll(EXAMPLE_OFFER)].length > 0
    const hypotheticalText = concreteExample ? clause.replace(/\bfor (?:example|exaple|exapmle|exmaple|exampel)\b/gi, '') : clause
    // Hypotheticals and quotes void the whole clause. A plain negation voids
    // only what it governs (see negatedLocally), so one refusal does not eat
    // a later ask in the same clause.
    if (HYPOTHETICAL.test(hypotheticalText)
      || /\bif\b[^.!?]{0,40}\bmight\s+take\b/i.test(clause)) continue
    // An accessorial charge is not the load's linehaul. A mixed financial
    // sentence is clarified rather than guessing which amount is the deal.
    if (/\b(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist|accessorial|per hour|\/hr)\b/i.test(clause)) continue
    // A per-mile figure is a comparison, never a settlement amount.
    if (/\b(?:per\s+mile|a\s+mile|\/\s*mi)\b/i.test(clause)) continue
    for (const pattern of [OFFER, ACCEPT_AT, EXAMPLE_OFFER]) {
      for (const m of clause.matchAll(pattern)) {
        if (negatedLocally(clause, m)) continue
        const tail = clause.slice(m.index + m[0].length)
        if (AMOUNT_UNIT_TAIL.test(tail)) continue
        addAmount(m[1], clause)
        if (pattern === ACCEPT_AT) acceptsAmount = true
      }
    }
    // A booking word beside a bare figure is the unplaced-close case further down.
    if (openNegotiation && !BOOK_WORD_RE.test(clause)) {
      for (const m of clause.matchAll(BARE_AMOUNT)) {
        if (negatedLocally(clause, m) || AMOUNT_UNIT_TAIL.test(clause.slice(m.index + m[0].length))
          || BARE_TIME_TAIL.test(clause.slice(m.index + m[0].length)) || BARE_JUDGED_TAIL.test(clause.slice(m.index + m[0].length)) || BARE_LABEL_BEFORE.test(clause.slice(0, m.index))) continue
        bareCandidates.push({ token: m[1], clause })
      }
    }
    // An amount-first or "let's" phrase has no verb to carry its own negation,
    // so a negation anywhere in the clause still voids it.
    const first = NEGATIVE.test(clause) ? null : AMOUNT_FIRST.exec(clause)
    if (first) { addAmount(first[1], clause); acceptsAmount = true }
    const book = NEGATIVE.test(clause) ? null : AMOUNT_BOOK.exec(clause.replace(TRAILING_SEPARATORS, ''))
    if (book) { addAmount(book[1], clause); acceptsAmount = true; confirmsOffer = true }
    const lets = NEGATIVE.test(clause) ? null : LETS_OFFER.exec(clause)
    if (lets) addAmount(lets[1], clause)
  }
  if (amounts.length === 0 && openNegotiation && Number.isFinite(rateSource?.rateUsd)) {
    const near = bareCandidates.filter(({ token }) => {
      const value = amountValue(token)
      return value >= rateSource.rateUsd * BARE_RATE_MIN_SHARE && value <= rateSource.rateUsd * BARE_RATE_MAX_SHARE
    })
    if (new Set(near.map(({ token }) => amountValue(token))).size === 1) addAmount(near[0].token, near[0].clause)
  }
  const unique = [...new Set(amounts)]
  if (unique.some((amount) => !Number.isSafeInteger(amount))) return { kind: 'ambiguous_rate', emails, useOwnEmail }
  const explicitMoney = [...amountSrc.replace(EMAIL, '').matchAll(/(?<!\w)(?:\$\s*(\d[\d,]*(?:\.\d+)?k?)|(\d+(?:\.\d+)?k)|(\d[\d,]*)\s*\$)(?!\w)/gi)]
    .map((m) => amountValue(m[1] ?? m[2] ?? m[3]))
  if (unique.length > 0 && new Set(explicitMoney).size > 1) return { kind: 'ambiguous' }
  if (unique.length === 1) {
    const split = rateSource?.rateBasis === SPLIT_RATE
    const totalSpecified = basisHints.some((hint) => hint.total)
    const linehaulSpecified = basisHints.some((hint) => hint.linehaul)
    if (split && totalSpecified === linehaulSpecified) return { kind: 'ambiguous_rate', requestedAmountUsd: unique[0], emails, useOwnEmail }
    return { kind: acceptsAmount ? 'accept_amount' : 'offer', rateUsd: unique[0] + (split && linehaulSpecified ? rateSource.fuelSurchargeUsd : 0), ...(confirmsOffer ? { confirmsOffer: true } : {}), ...(keyed?.reason ? { reason: keyed.reason } : {}), emails, useOwnEmail }
  }
  if (unique.length > 1) return { kind: 'ambiguous' }
  // The answer to "total or linehaul plus fuel?" carries no figure of its own.
  if (unique.length === 0 && Number.isSafeInteger(pendingBasisUsd)) {
    if (BASIS_ANSWER_TOTAL.test(src)) return { kind: 'offer', rateUsd: pendingBasisUsd, emails, useOwnEmail }
    if (BASIS_ANSWER_LINEHAUL.test(src) && Number.isSafeInteger(rateSource?.fuelSurchargeUsd)) {
      return { kind: 'offer', rateUsd: pendingBasisUsd + rateSource.fuelSurchargeUsd, emails, useOwnEmail }
    }
  }
  // Permit an explicit acceptance followed by an email instruction, but no conditional price.
  const acceptance = src.split(/(?<=[.!])\s+/)[0]
  if (!NEGATIVE.test(acceptance) && !HYPOTHETICAL.test(acceptance) && ACCEPT.test(acceptance)) return { kind: 'accept', emails, useOwnEmail }
  if (emails.length === 1 || useOwnEmail) return { kind: 'email', emails, useOwnEmail }
  if (WALK.test(src)) return { kind: 'walk' }
  if (MORE.test(src) || REJECT_PRICE.test(src) || keyed?.kind === 'push') return { kind: 'push', ...(keyed?.reason ? { reason: keyed.reason } : {}) }
  return { kind: 'talk' }
}

// The first ladder rung: STEP_1_SHARE of the room above the posted rate,
// rounded to $25, never above the ceiling or the carrier's own ask. Used for
// "what's the best you can do" and for a first push; a first push WITH a
// reason skips straight to the second rung, which must not land below it
// (live T2 #208: with a reason 2,578 < 2,603 without).
export function firstRungOffer(posting, amount = Infinity) {
  const ceiling = ceilingFor(posting)
  const room = Math.max(0, ceiling - posting.rateUsd)
  const allowance = Math.max(25, Math.round(room * STEP_1_SHARE / 25) * 25)
  return Math.min(ceiling, posting.rateUsd + allowance, amount)
}

// Carrier reasons the server can check against the load's facts, keyed to
// the rateReasons() name that would make each one true.
const CHECKABLE_REASON = Object.freeze({ reload: 'weak-reload', deadhead: 'deadhead', 'tight-window': 'tight-window' })

function unverifiedReasonFor(intent, { posting, truck, now }) {
  const key = CHECKABLE_REASON[intent.reason]
  return Boolean(key) && !rateReasons({ posting, truck, now }).includes(key)
}

const money = (n) => `$${Number(n).toLocaleString('en-US')}`
// Sharing a truck/driver or asking a price is not a request to book.
// Use the same intent at the prompt and reply boundary so MC cannot gate haggling.
export function bookingTurn(text, decision = null) {
  text = intentText(text)
  const intent = decision?.intent ?? chatIntent(text)
  if (intent.kind === 'accept') return true
  if (['offer', 'accept_amount'].includes(intent.kind)) return decision ? decision.bookingRequested === true : intent.kind === 'accept_amount'
  if (intent.kind === 'email') return decision?.state.agreed !== null && decision?.state.agreed !== undefined
  if (intent.kind !== 'talk' || NEGATIVE.test(text) || HYPOTHETICAL.test(text)) return false
  return /\b(?:can (?:we|i) book|ready to book)\b/i.test(text)
}

export function negotiationState(conversation, posting) {
  return {
    stage: conversation.negotiationStage ?? (conversation.status === 'booked' ? 'booked' : conversation.status === 'agreed' ? 'paper_pending' : 'negotiating'),
    offer: conversation.brokerOfferUsd ?? posting.rateUsd,
    agreed: conversation.agreedRateUsd ?? null,
    recipient: conversation.recipientEmail ?? null,
    pushes: conversation.ratePushCount ?? 0,
    bestCounterUsed: conversation.bestCounterUsed ?? false,
    // A price the carrier closed at before their MC checked out (live T3
    // #218-#219): accepted on price, waiting only for the MC.
    pendingClose: conversation.pendingCloseUsd ?? null,
  }
}

// The newest price the dispatcher asked for, from their earlier messages. The
// broker never gives more than this, so a later push or walk stops here.
export function lastCarrierAskUsd(texts, posting) {
  for (const text of [...(texts ?? [])].reverse()) {
    const intent = chatIntent(text, posting, { openNegotiation: true })
    if (['offer', 'accept_amount'].includes(intent.kind) && Number.isSafeInteger(intent.rateUsd)) return intent.rateUsd
  }
  return null
}

// The figure the dispatcher gave that the broker then asked "total or linehaul
// plus fuel?" about, when the newest dispatcher message is the answer to it.
export function pendingBasisAskUsd(thread, posting) {
  const said = (thread ?? []).filter((message) => message.kind !== 'rate_con')
  if (said.at(-1)?.role === 'dispatcher') said.pop()
  const question = said.at(-1)
  if (question?.role !== 'broker' || !BASIS_QUESTION.test(question.content ?? '')) return null
  const asked = said.at(-2)
  if (asked?.role !== 'dispatcher') return null
  const intent = chatIntent(asked.content, posting, { openNegotiation: true })
  return intent.kind === 'ambiguous_rate' && Number.isSafeInteger(intent.requestedAmountUsd) ? intent.requestedAmountUsd : null
}

export function negotiate({ conversation, posting, text, booking, truck, effectiveEmail = null, knownEmail = null, now = new Date(), offerVisible = false, pendingBasisUsd = null, lastAskUsd = null }) {
  const previous = negotiationState(conversation, posting)
  const state = { ...previous }
  const pending = previous.pendingClose
  state.pendingClose = null
  const intent = chatIntent(text, posting, {
    openNegotiation: previous.agreed === null && ['negotiating', 'held'].includes(previous.stage) && conversation.status !== 'booked',
    pendingBasisUsd,
  })
  const quote = (amount) => quoteText(posting, amount)
  let changed = false
  let issuePaper = false
  let invalidatePaper = false
  let line = null
  let bookingRequested = false
  const verified = booking?.mc?.verdict === 'match'
  const clear = () => { state.agreed = null; state.recipient = null; state.stage = 'negotiating'; invalidatePaper = true; changed = true }
  const agree = (amount) => {
    bookingRequested = true
    if (!verified) {
      line = ['mismatch', 'unverifiable'].includes(booking?.mc?.verdict) ? 'What is your correct MC?' : "What's your MC?"
      state.pendingClose = amount; state.offer = amount; changed = true
      return
    }
    if (truck?.makesIt === false || booking?.trailer?.fits === false) { line = 'We need a truck that can meet the pickup and equipment requirements before confirming.'; return }
    if (state.agreed !== amount || state.stage === 'held') clear()
    state.offer = amount; state.agreed = amount; state.stage = 'awaiting_email'; changed = true
    line = `${quote(amount)} agreed. What email should I put on the rate confirmation?`
  }
  if (state.stage === 'booked' || conversation.status === 'booked') return { state, intent, changed, issuePaper, invalidatePaper, bookingRequested, line: null }
  if (intent.kind === 'rebroker') {
    line = ONE_CARRIER_REPLY
  } else if (intent.kind === 'ambiguous_rate') {
    line = 'Do you mean the total including fuel, or linehaul plus the listed fuel amount?'
  } else if (intent.kind === 'hold') {
    clear(); state.stage = 'held'; line = 'Understood. I will hold off on the rate confirmation until you confirm.'
  } else if (intent.kind === 'cancel') {
    // Nothing is booked yet, so there is nothing to block; an agreed rate that
    // was not signed is dropped. (A load named outright on an agreed or booked
    // thread is handled before this, by cancellationDecision.)
    if (state.agreed === null) line = NOT_BOOKED_CANCEL_LINE
    else { clear(); line = AGREEMENT_DROPPED_LINE }
  } else if (intent.kind === 'ask_room') {
    // Room questions receive the next authorized counter without exposing
    // the ceiling; this is the broker's normal first bargaining step.
    state.offer = Math.max(state.offer, firstRungOffer(posting))
    if (state.offer !== previous.offer) changed = true
    line = `I can offer ${quote(state.offer)}. Does that work for you?`
  } else if (['offer', 'accept_amount', 'push'].includes(intent.kind)) {
    const amount = intent.kind === 'push' ? Math.min(ceilingFor(posting), lastAskUsd ?? Infinity) : intent.rateUsd
    const min = Math.max(100, posting.distanceMi, posting.rateBasis === SPLIT_RATE ? posting.fuelSurchargeUsd + 1 : 0)
    const max = Math.min(20000, posting.distanceMi * 5)
    if (state.agreed !== null && (amount !== state.agreed || intent.kind === 'push')) clear()
    if (amount < min || amount > max) {
      line = `I cannot do that figure. My offer is ${quote(state.offer)}.`
    } else if (intent.kind === 'accept_amount' && !intent.confirmsOffer && amount <= ceilingFor(posting)) {
      // A conditional close settles anywhere inside the broker's authorized
      // ceiling, even when it is above the current quote. Above the ceiling it
      // is only an ask and goes to the ladder below ("book it at 9000" used to
      // be booked at 9000).
      agree(amount)
    } else if ((intent.kind === 'offer' || intent.confirmsOffer) && amount <= state.offer) {
      // "yes 3500 book it" confirms a quote at or below ours; above ours it is
      // an ask like any other offer.
      // Record the validated settlement attempt even when MC verification
      // prevents agreement. Prompt and guard must allow that required question.
      bookingRequested = true
      if (state.agreed === amount && ['paper_pending', 'paper_delivered'].includes(state.stage)) line = 'The rate confirmation is already in this thread or on its way.'
      else agree(amount)
    } else {
      clear(); state.pushes += 1
      const reasons = rateReasons({ posting, truck, now }).filter((key) => REASON_WORDS[key].test(text))
      const steps = reasons.length > 0 ? 2 : 1
      const effectivePush = state.pushes + steps - 1
      if (effectivePush >= 3) {
        // Never more than was asked: the ceiling only when the ask is above it.
        state.offer = Math.max(state.offer, Math.min(ceilingFor(posting), amount))
      } else if (effectivePush === 2) {
        const ceiling = ceilingFor(posting)
        // A first push with a verified reason jumps to the second rung; it
        // starts from the first rung so the reasoned counter is never lower
        // than the unreasoned one.
        const skippedFirstRung = steps === 2 && state.pushes === 1
        const base = skippedFirstRung ? Math.max(state.offer, firstRungOffer(posting, amount)) : state.offer
        const step = Math.max(25, Math.round((Math.min(amount, ceiling) - base) * STEP_2_SHARE / 25) * 25)
        state.offer = Math.min(ceiling, base + step)
      } else {
        // Ordinary bargaining can earn one small counter, not an endless
        // ladder. Anchor it to the posting so retries never compound it.
        state.offer = Math.max(state.offer, firstRungOffer(posting, amount))
      }
      if (state.offer >= ceilingFor(posting)) line = previous.offer >= ceilingFor(posting)
        ? `${quote(state.offer)} is as high as I can go.`
        : `Best I can do is ${quote(state.offer)}. That's my max.`
      else if (intent.kind !== 'push' && state.offer === amount) line = `I can do ${quote(amount)}. Want me to book it?`
      else line = `I can offer ${quote(state.offer)}. Does that work for you?`
    }
  } else if (intent.kind === 'accept') {
    if (!offerVisible) line = `My offer is ${quote(state.offer)}. Can you confirm that rate?`
    else if (state.agreed === state.offer && ['paper_pending', 'paper_delivered'].includes(state.stage)) line = 'The rate confirmation is already in this thread or on its way.'
    else agree(state.offer)
  } else if (intent.kind === 'walk' && state.agreed !== null) {
    clear(); state.stage = 'held'; line = 'Understood. I will withdraw the rate confirmation.'
  } else if (intent.kind === 'walk' && state.agreed === null && !state.bestCounterUsed) {
    clear(); state.bestCounterUsed = true
    state.offer = Math.max(state.offer, Math.min(ceilingFor(posting), lastAskUsd ?? Infinity))
    line = `Before you go, I can do ${quote(state.offer)}. Would that work?`
  } else if (['talk', 'ambiguous'].includes(intent.kind) && state.agreed === null && pending === null
    && new RegExp(MONEY, 'i').test(intentText(text)) && BOOK_WORD_RE.test(intentText(text)) && !NEGATIVE.test(text)) {
    // A figure and a booking word that no rule could place: ask, never "Noted."
    line = confirmBookLine(quote(state.offer))
  }
  // A conditional close waits for the MC, not for the price: once the MC
  // checks out on a non-financial turn, the earlier price is agreed. Any
  // financial turn already replaced or cleared it (state.pendingClose = null).
  if (pending !== null && state.agreed === null && ['talk', 'question', 'terms', 'commodity', 'email'].includes(intent.kind)) {
    if (verified) agree(pending)
    else state.pendingClose = pending
  }
  // Sharing an email is authorization only after a handshake; never from profile alone.
  if (state.stage === 'awaiting_email' && ['email', 'accept', 'accept_amount', 'offer'].includes(intent.kind)) {
    const email = intent.emails?.length === 1 ? intent.emails[0] : intent.useOwnEmail ? effectiveEmail : knownEmail
    if (email && !verified) {
      line = ['mismatch', 'unverifiable'].includes(booking?.mc?.verdict) ? 'What is your correct MC?' : "What's your MC?"
    } else if (email && (truck?.makesIt === false || booking?.trailer?.fits === false)) {
      line = 'We need a truck that meets the pickup and equipment requirements before I prepare the rate confirmation.'
    } else if (email) {
      state.recipient = email; state.stage = 'paper_pending'; issuePaper = true; changed = true
      line = `${quote(state.agreed)} confirmed. The rate confirmation will appear here shortly for you to review and sign.`
    } else if (intent.kind === 'email') line = 'Please provide the email address you want on the rate confirmation.'
  } else if (intent.kind === 'email' && state.agreed === null) {
    line = `Before I prepare the rate confirmation, can you confirm ${quote(state.offer)}?`
  }
  return { state, intent, changed, issuePaper, invalidatePaper, bookingRequested, line, knownEmail,
    // The broker's own writing style and a per-turn key for picking wording.
    style: brokerStyle(posting.brokerId),
    voiceKey: voiceKey({ brokerId: posting.brokerId, conversationId: conversation.id ?? posting.id, revision: conversation.negotiationRevision ?? 0 }),
    previousOfferUsd: previous.offer,
    // The carrier gave a reason the load's facts do not support: the reply
    // must not repeat it as fact (live #209 "Reloads are weak").
    unverifiedReason: unverifiedReasonFor(intent, { posting, truck, now }),
    // Voice must not turn a temporary hold into an absolute economic limit.
    rateQuote: rateQuote(posting, state.offer),
    hasRateRoom: state.offer < ceilingFor(posting), requiresMc: bookingRequested && !verified }
}

export function negotiationLines(decision) {
  if (!decision) return []
  return ['AUTHORITATIVE RATE DECISION FOR THIS TURN:',
    `  Your current offer is ${quoteText(decision.rateQuote ?? { rateUsd: decision.state.offer })}. Agreed total: ${decision.state.agreed === null ? 'none' : money(decision.state.agreed)}.`,
    ...(decision.rateQuote?.rateBasis === SPLIT_RATE ? ['  Fuel is the fixed quoted component; any authorized change in total changes linehaul only. Never add fuel to the total again.'] : []),
    `  Stage: ${decision.state.stage}.`,
    `  Carrier intent: ${decision.intent.kind}${decision.intent.rateUsd ? `; requested price ${money(decision.intent.rateUsd)}` : ''}.`,
    `  Booking requested: ${decision.bookingRequested ? 'yes' : 'no'}. Document authorized this turn: ${decision.issuePaper ? 'yes' : 'no'}.`,
    ...(decision.state.agreed === null ? ['  No handshake exists; a requested price is not an accepted deal.'] : []),
    ...(decision.hasRateRoom && decision.state.agreed === null ? ['  Describe this turn as a current quote. A later financial decision remains separate; make no claim about future movement.'] : []),
    ...(['offer', 'push', 'accept_amount'].includes(decision.intent.kind) && !decision.bookingRequested
      ? ['  Answer their bargaining request with the current authorized offer; do not present their requested price as accepted.'] : []),
    ...(decision.state.stage === 'awaiting_email' ? ['  Rate is agreed. Ask which email to send the rate con to, in plain desk words; never say "authorized" or "recipient".'] : []),
    ...(decision.unverifiedReason ? ["  The carrier's stated reason is not supported by this load's facts; do not repeat or agree with it."] : []),
    ...(decision.state.pendingClose != null ? [`  Their conditional close at ${money(decision.state.pendingClose)} is accepted on price; only their MC is missing. Do not quote another figure.`] : []),
    ...(decision.state.stage === 'held' ? ['  Booking is on hold; do not request email or promise a document.'] : []),
    ...(decision.issuePaper ? ['  The authorized document will appear in this chat shortly for review and signature; do not claim an email was sent.'] : []),
    ...(decision.bookingRequested && decision.state.agreed === null ? ['  The rate cannot be confirmed yet. Follow the verified caller and equipment facts for the missing prerequisite.'] : []),
    ...(decision.requiresMc ? ['  Their rate acceptance is understood; request their MC. Ask for a correct MC only after a mismatch or an unverifiable number. Do not say we are set, locked in or sending paper.'] : []),
    '  These are facts, not a script. Use your own words; never change the amount, acceptance, recipient authorization or document state.',
    '  Do not agree to another number or create a handshake through prose. Answer any direct operational question first.', '']
}

// A cap stated as fact ("$4,750 max", "as high as I can go"). Unlike the
// rate-word patterns below, "right now" and "for now" do not soften it; only
// a quoted dispatcher ("you said", "your") is not the broker's own claim.
const CAP_CLAIM = /\b(?:(?:my|our|the|that'?s|thats|is)\s+max(?:imum)?|\d[\d,]*k?\s+max(?:imum)?|max(?:imum)?\s+(?:i|we)\s+can|as high as (?:i|we)(?: can)? go|(?:that'?s|thats|that is)\s+(?:my|our|the)\s+(?:limit|ceiling|top)|top dollar|tapped out|(?:cant|wont)\s+(?:go|pay|move|come)(?: any)? (?:higher|above|up|more))\b/i
const claimsCap = (clause) => !/\b(?:you said|u said|your|ur)\b/i.test(clause) && CAP_CLAIM.test(clause)

export function negotiationReplyProblem(reply, decision) {
  if (!decision) return null
  const text = asciiPunct(reply)
  // Repeating an unresolved carrier amount while explicitly asking its
  // basis is not our offer. The narrow question grammar excludes booking
  // or payment promises and validates all other amounts against fixed fuel.
  if (clarifiesRequestedBasis(text, decision)) return null
  if (decision.hasRateRoom && decision.state.agreed === null) {
    const claims = text.split(/(?<=[.!?;])\s+|\b(?:but|however)\b/i)
    if (claims.some((clause) => !clause.includes('?') && (claimsCap(clause) || !/\b(?:you said|u said|your|ur|not (?:my|a|the|our)|isn't my|is not my|haven't called|didn't say|never said|right now|at the moment|for now)\b/i.test(clause)
      && /\b(?:final (?:rate|offer|price)|(?:my |the |our )?(?:absolute )?best (?:rate|offer|price)|best (?:i|we) can (?:do|pay|offer)|(?:can(?:not|'t)|cant|won't|wont|will not|not|unable to) (?:go|mov(?:e|ing)|come|pay)(?: any)? (?:higher|above|up)|(?:can(?:not|'t)|cant|won't|wont|will not|not|unable to) (?:increas\w*|improv\w*|rais\w*|bump\w*)|(?:most|highest|top) (?:i|we) can (?:do|pay|offer))\b/i.test(clause)))) {
      return 'claimed a permanent final rate while authorized bargaining room remains'
    }
  }
  const allowed = [decision.state.offer, decision.state.agreed].filter((n) => n !== null)
  const splitQuote = decision.rateQuote?.rateBasis === SPLIT_RATE ? decision.rateQuote : null
  if (addsFuelToTotal(text, allowed)) return 'added fuel on top of the authoritative total'
  // Classify individual amounts within their own clause. A carrier's ask
  // is not our offer, and a later sentence cannot lend its rate words to it.
  // Never mask an amount globally: a second occurrence may promise payment.
  const clauses = text.split(/(?<=[.!?;])\s+|\b(?:but|however|and)\b/i)
  let lastReferencedAmount = null
  for (const clause of clauses) {
    const amounts = [...clause.matchAll(REPLY_MONEY)]
    for (const [index, match] of amounts.entries()) {
      const amount = amountValue(match[1] ?? match[2])
      const before = clause.slice(index ? amounts[index - 1].index + amounts[index - 1][0].length : 0, match.index)
      const after = clause.slice(match.index + match[0].length, amounts[index + 1]?.index ?? clause.length)
      const units = /^\s*(?:(?:\/|per\s+|an?\s+)(?:hours?|hrs?|days?|miles?|mi|lbs?|pounds?)\b|hr\b|hours?\b|lbs?\b|pounds?\b|miles?\b|mi\b|ft\b|feet\b)/i.test(after)
        || (match[1] === undefined && /^\s*-\s*(?:miles?|mi|hours?|hrs?|days?|lbs?|pounds?|ft|feet|foot)\b/i.test(after))
      const accessorial = /\b(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist)\s*(?:is|:|of|at)?\s*$/i.test(before)
        || /^\s*(?:for\s+)?(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist)\b/i.test(after)
      if (units || accessorial) continue
      // A component is valid only under its own label; equal numeric values
      // do not turn fuel into total or an unapproved total into linehaul.
      const fuelLabel = /^\s*(?:for\s+)?fuel(?: surcharge)?\b/i.test(after) || /\bfuel(?: surcharge)?\s*(?:is|:|of|at)?\s*$/i.test(before)
      const linehaulLabel = /^\s*linehaul\b/i.test(after) || /\blinehaul\s*(?:is|:|of|at)?\s*$/i.test(before)
      // A figure beside a + or = in a split quote is an arithmetic line
      // ("3,700 linehaul + 1,406 fuel = 5,106"): its unlabelled sum is money
      // too, so a wrong total cannot slip past as plain digits.
      const inSplitSum = splitQuote !== null && (/[+=]\s*$/.test(before) || /^\s*[+=]/.test(after))
      // A component label makes a bare number money even with no $ or rate word.
      const financial = match[1] !== undefined || fuelLabel || linehaulLabel || inSplitSum
        || /all[- ]?in|\b(?:rate|offer|pay|do|ask|asked|requested|looking for|works|agreed|confirmed)\b/i.test(`${before} ${after}`)
      if (!financial) continue
      lastReferencedAmount = amount
      if (splitQuote && (fuelLabel || linehaulLabel)) {
        const expected = fuelLabel ? [splitQuote.fuelSurchargeUsd] : allowed.map((total) => total - splitQuote.fuelSurchargeUsd)
        if (expected.includes(amount)) continue
      } else if (inSplitSum) {
        // Unlabelled in a sum: only fuel, the total, or total minus fuel are true.
        const sumFigures = [splitQuote.fuelSurchargeUsd, ...allowed, ...allowed.map((total) => total - splitQuote.fuelSurchargeUsd)]
        if (sumFigures.includes(amount)) continue
      } else if (allowed.includes(amount)) continue
      const attributed = /\b(?:you|u)(?:'re| are| were)\s+(?:looking|asking|aiming|hoping)\s+for\s*$/i.test(before)
        || /\b(?:you|u)\s+(?:asked(?: for)?|requested|wanted)\s*$/i.test(before)
        || /\b(?:your|ur)\s+(?:(?:requested|asking|target)\s+)?(?:price|rate|ask|request)\s*(?:of|is|:)?\s*$/i.test(before)
        || (/\b(?:your|ur)\s*$/i.test(before) && /^\s*(?:ask|request)\b/i.test(after))
      const committed = /\b(?:pay|offer|meet|match|accept|approve|agree)\b|\b(?:our|my)\s+(?:offer|rate|payment)\s+(?:is|will be)\b/i.test(before)
        || /\b(?:approved|accepted|agreed|confirmed)\b/i.test(after)
        || /^\s*[,;:]?\s*(?:(?:ask|request)\s+)?(?:works|(?:will|would)\s+work|(?:sounds|looks)\s+(?:good|fine)|(?:is|will be)\s+fine|deal)\b/i.test(after)
      const requestedAmount = splitQuote && linehaulLabel ? decision.intent.rateUsd - splitQuote.fuelSurchargeUsd : decision.intent.rateUsd
      if (!(attributed && !committed && amount === requestedAmount)) return RATE_MISS_REASON
    }
    // A quoted ask cannot become a payment promise through a later pronoun.
    // Track the latest monetary referent so a subsequent authorized offer can
    // still be followed by "I can pay that" without inheriting the old ask.
    if (lastReferencedAmount !== null && !allowed.includes(lastReferencedAmount)
      && /\b(?:i|we)(?:'ll|'d)?\s+(?:(?:can|will|would)\s+)?(?:pay|offer|match|meet|accept|approve|agree to)\s+(?:that|it|your (?:ask|rate|request))\b|\b(?:that|it)(?:(?:'s| is| will be)\s+(?:approved|accepted|agreed|confirmed|fine)|\s+(?:works|sounds good))\b/i.test(clause)
      && !NEGATIVE.test(clause)) return RATE_MISS_REASON
  }
  if (decision.state.agreed === null) {
    const assertions = text.replace(EMAIL, ' ').split(/(?<=[.!?;])\s+|\b(?:but|however)\b/i)
      .filter((clause) => !NEGATIVE.test(clause) && !/\bno\b/i.test(clause) && !HYPOTHETICAL.test(clause) && !clause.includes('?'))
    const accepts = /\b(?:deal|done|agreed|confirmed|it'?s yours|(?:you|we)(?:'re| are) (?:all )?set|(?:we(?:'re| are)|we have|we've|i have|i've)(?: (?:it|this|the rate))? locked in|locked (?:in|at)\s+(?:at\s+)?\$?\d|i accept (?:your|the) (?:offer|rate))\b/i
    if (saysBooked(text) || assertions.some((clause) => accepts.test(clause))) return 'invented an agreement without dispatcher acceptance'
  }
  if (decision.state.stage === 'held' && /\b(?:send (?:me|your)|give me|what(?:'s| is))[^.!?]{0,25}\be-?mail\b/i.test(text)) return 'asked for email despite a booking hold'
  if (decision.line && ['awaiting_email', 'paper_pending'].includes(decision.state.stage) && decision.intent.kind !== 'talk' && !new RegExp(`\\b${decision.state.agreed}\\b`).test(text.replaceAll(',', ''))) return 'omitted the agreed rate from the confirmation'
  if (decision.line && decision.state.stage === 'awaiting_email' && !/\b(?:agreed|confirmed|locked (?:in|at)|deal|works|can do|okay|ok|set)\b/i.test(text)) return 'did not convey the confirmed rate decision'
  // Only a server-recognized settlement attempt requires identity collection.
  if (decision.requiresMc && !mcQuestion(text)
    && !/\b(?:send|give|provide|share)\s+(?:me\s+)?(?:(?:your|the|correct)\s+)?mc\b/i.test(text)
    && !/\b(?:if|once|when|after)\s+your\s+mc\s+checks out\b/i.test(text)) return 'did not request the MC required before confirming the rate'
  return null
}

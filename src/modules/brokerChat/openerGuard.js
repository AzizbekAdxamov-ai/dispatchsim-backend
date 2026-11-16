// How a broker message begins. Azizbek 2026-11-15: "hey" is not how a broker
// opens, A/B-rated brokers are more formal, C/D shorter, and two messages in a
// row never start with the same word. A deterministic last step: it only
// touches the first words, never a figure or a question further in.
import { pickVariant, openerRegister } from './brokerStyle.js'
import { REPEAT_LEADS } from './repeatGuard.js'
import { GREETING_LEAD } from './turnTalk.js'

export const BANNED_OPENERS = Object.freeze(['hey', 'yep', 'yeah', 'yup', 'yo'])

// Whole-sentence leads (ending in a period) so the body keeps its own capital.
export const OPENER_LEADS = Object.freeze({
  formal: Object.freeze(['Understood.', 'Certainly.', 'Thank you.']),
  short: Object.freeze(['Ok.', 'Sure.', 'Got it.']),
})

// Anything before the first letter, digit or dollar sign: emoji, quotes, dashes.
const LEADING_NOISE = /^[^\p{L}\p{N}$]+/u
// "hey", "yo", "yep" ... and the pet word that may follow ("there", "bro").
// A capitalised name right before punctuation ("Hey Mike!", "Yep Dana,").
const NAME_AFTER = /^\s+[A-Z][a-z]+(?=[,!.?])/
const OPENING_GAP = /^[\s,!.:;-]+/
const BANNED_OPENING = new RegExp(String.raw`^(?:${BANNED_OPENERS.join('|')})\b(?:[\s,]+(?:there|man|bro|brother|buddy|boss|sir|mate|dude)\b)?`, 'i')
// A broker introducing themselves right after the greeting: "Dana here."
const SELF_INTRO = /^[A-Z][a-z]+ here\b[\s,!.:;-]*/
// "whats up" / "what's up" left over after "yo bro".
const GREETING_TAIL = /^what'?s up\b[\s,!.?:;-]*/i
// A reply that opens with an acknowledgment; the word it would repeat.
const ACK_OPENING = /^(?:thank you|thanks|got it|okay|ok|yes|sure|understood|certainly|alright|all right|noted)\b[\s,!.:;-]*/i
const OPENS_WITH_FIGURE = /^\$|^\d/
const FIRST_WORD = /[a-z0-9']+/i
const REPEAT_LEAD_WORDS = new Set(REPEAT_LEADS.map((lead) => lead.match(FIRST_WORD)[0].toLowerCase()))

const firstWordOf = (text) => String(text ?? '').match(FIRST_WORD)?.[0].toLowerCase() ?? null
const capitalised = (text) => (text === '' ? text : text[0].toUpperCase() + text.slice(1))

// A plain acknowledgment of this tier's register that does not start with
// `avoid` (the first word of the last broker message).
function acknowledgment(register, key, avoid) {
  const options = OPENER_LEADS[register].filter((lead) => firstWordOf(lead) !== avoid)
  return pickVariant(options.length > 0 ? options : OPENER_LEADS[register], `${key}:opener`)
}

// "Hey", "Hey Mike!", "hey, hey", "yo bro whats up", "👍 Yep, sure." lose the
// banned opening (as often as it repeats). Nothing left: an acknowledgment.
function stripBannedOpener(reply, register, key, avoid) {
  let rest = reply.replace(LEADING_NOISE, '')
  if (!BANNED_OPENING.test(rest)) return reply
  while (BANNED_OPENING.test(rest)) {
    rest = rest.replace(BANNED_OPENING, '').replace(NAME_AFTER, '').replace(OPENING_GAP, '').replace(SELF_INTRO, '').replace(GREETING_TAIL, '').replace(LEADING_NOISE, '')
  }
  if (!FIRST_WORD.test(rest)) return acknowledgment(register, key, avoid)
  return /^[^a-z]*[A-Z]/.test(reply.replace(LEADING_NOISE, '')) ? capitalised(rest) : rest
}

// An opening acknowledgment the last message already used, swapped for another
// one ("Ok, I can do $3,750." after "Ok, noted." -> "Sure, I can do $3,750.").
function swapAcknowledgment(text, register, key, avoid) {
  const rest = text.replace(ACK_OPENING, '')
  const lead = acknowledgment(register, key, avoid)
  return rest.trim() === '' ? lead : `${lead.replace(/\.$/, ',')} ${rest}`
}

// fixedWording: the server's own line (a quote, a booking step). Only a banned
// opener is removed from it; no lead-in is put in front of its figures.
export function fixOpener(reply, { brokerSaid = [], creditRating = null, key = '', fixedWording = false } = {}) {
  let text = String(reply ?? '')
  if (text.trim() === '') return text
  const register = openerRegister(creditRating)
  const last = firstWordOf((brokerSaid ?? []).at(-1))
  text = stripBannedOpener(text, register, key, last)
  if (fixedWording) return text
  const first = firstWordOf(text)
  // A figure is not a word to vary, a repeat lead-in ("Like I said") and a greeting are meant to recur.
  if (last === null || first !== last || OPENS_WITH_FIGURE.test(text.trimStart()) || REPEAT_LEAD_WORDS.has(first) || GREETING_LEAD.test(text.trim())) return text
  if (ACK_OPENING.test(text.trimStart())) return swapAcknowledgment(text.trimStart(), register, key, last)
  return `${acknowledgment(register, key, last)} ${text.trimStart()}`
}

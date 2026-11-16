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

// "hey", "hey there", "yep," ... at the very start, with what follows them.
const BANNED_OPENING = new RegExp(String.raw`^\s*(?:${BANNED_OPENERS.join('|')})\b(?:\s+there\b)?[\s,!.:;-]*`, 'i')
const FIRST_WORD = /[a-z0-9']+/i
const REPEAT_LEAD_WORDS = new Set(REPEAT_LEADS.map((lead) => lead.match(FIRST_WORD)[0].toLowerCase()))

const firstWordOf = (text) => String(text ?? '').match(FIRST_WORD)?.[0].toLowerCase() ?? null

function stripBannedOpener(reply, register, key) {
  if (!BANNED_OPENING.test(reply)) return reply
  const rest = reply.replace(BANNED_OPENING, '')
  // Nothing but the banned word was said: a plain acknowledgment takes its place.
  if (!FIRST_WORD.test(rest)) return pickVariant(OPENER_LEADS[register], `${key}:opener`)
  const wasCapital = /^\s*[A-Z]/.test(reply)
  return wasCapital ? rest[0].toUpperCase() + rest.slice(1) : rest
}

// fixedWording: the server's own line (a quote, a booking step). Only a banned
// opener is removed from it; no lead-in is put in front of its figures.
export function fixOpener(reply, { brokerSaid = [], creditRating = null, key = '', fixedWording = false } = {}) {
  let text = String(reply ?? '')
  if (text.trim() === '') return text
  const register = openerRegister(creditRating)
  text = stripBannedOpener(text, register, key)
  if (fixedWording) return text
  const last = firstWordOf((brokerSaid ?? []).at(-1))
  const first = firstWordOf(text)
  // A repeat lead-in ("Like I said") and a greeting are meant to recur.
  if (last === null || first !== last || REPEAT_LEAD_WORDS.has(first) || GREETING_LEAD.test(text.trim())) return text
  const choices = OPENER_LEADS[register].filter((lead) => firstWordOf(lead) !== first)
  return `${pickVariant(choices, `${key}:opener`)} ${text.trimStart()}`
}

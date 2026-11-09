import { asciiPunct } from '../../lib/plainText.js'
import { pickVariant } from './brokerStyle.js'

// An introduction is social context, not identification of a particular load.
// Keep the same boundary in the prompt, guard and deterministic fallback.
export const GREETING_LEAD = /^(?:hi|hey|hello|yo|bro|wass?up|wassap|what'?s up|good (?:morning|moring|afternoon|evening))\b/i
// "how are you" asked at the end of a greeting: social, so the message is still only a greeting.
const HOW_ARE_YOU_TAIL = /[\s,!.]+(?:how(?:'s| is) it going|how (?:are|r) (?:you|u|ya)(?: doing| today)?|how you doing|hru|u good|you good)\s*[?.!]*\s*$/i
// A reply that already greets back in its first sentence.
export const GREETS_BACK = /\b(?:hi|hey|hello|morning|afternoon|evening|good day|doing|thanks|thx)\b/i

const withoutHowAreYou = (text) => text.replace(HOW_ARE_YOU_TAIL, '')

export function introductionOnly(raw) {
  const text = withoutHowAreYou(asciiPunct(String(raw ?? '')).trim()).trim()
  return GREETING_LEAD.test(text)
    && !/[?$]/.test(text)
    && !/\b(?:load|available|avaivable|open|rate|price|pickup|delivery|fuel|deadhead|deadhed|book|need|want|can|could|from .+ to)\b/i.test(text)
    && /^(?:hi|hey|hello|yo|bro|wass?up|wassap|what'?s up|good (?:morning|moring|afternoon|evening))(?:[\s,!.]+(?:sir|ma'?am|brother|bro|man|there))*[\s,!.]*(?:(?:i'?m|i am|this is|it'?s)\s+[\w '&.,-]+)?[.!\s]*$/i.test(text)
}

export function asksHowAreYou(raw) {
  return HOW_ARE_YOU_TAIL.test(asciiPunct(String(raw ?? '')).trim())
}

const DEFAULT_GREETING = 'Hey! Good to hear from you.'

// Wording for a broker answering a bare greeting, in each writing style. None
// of them names a lane, a price or the word "load": they only greet back (and
// say how they are, when asked).
const GREETING_VARIANTS = Object.freeze({
  casual: Object.freeze([
    (asked) => (asked ? 'hey! doing good, u?' : 'hey! good to hear from u.'),
    (asked) => (asked ? 'hi! all good here, u?' : 'hi! whats up.'),
    (asked) => (asked ? 'hey there, doing well, u?' : 'hey there!'),
    (asked) => (asked ? 'hello! good, thx, u?' : 'hello! good to hear from u.'),
  ]),
  neutral: Object.freeze([
    (asked) => (asked ? 'Hey! Doing good, thanks. You?' : DEFAULT_GREETING),
    (asked) => (asked ? 'Hi! All good here, how about you?' : 'Hi! Good to hear from you.'),
    (asked) => (asked ? 'Hey there, doing well. And you?' : 'Hey there!'),
    (asked) => (asked ? 'Hello! Good, thanks. You?' : 'Hello! Good to hear from you.'),
  ]),
  formal: Object.freeze([
    (asked) => (asked ? 'Hello! I am doing well, thank you. And you?' : 'Hello! It is good to hear from you.'),
    (asked) => (asked ? 'Good day! I am well, thank you. How are you?' : 'Good day! Good to hear from you.'),
    (asked) => (asked ? 'Hello, I am doing well, thanks. And yourself?' : 'Hello, and thank you for reaching out.'),
    (asked) => (asked ? 'Hi! Doing well, thank you. How about you?' : 'Hi! Good to hear from you.'),
  ]),
})

// A few words that greet back, to put in front of an answer that skipped it.
const GREETING_LEADS = Object.freeze({
  casual: Object.freeze(['hey!', 'hi!', 'hey there!']),
  neutral: Object.freeze(['Hey!', 'Hi!', 'Hello!']),
  formal: Object.freeze(['Hello!', 'Good day!', 'Hi!']),
})

export function introductionReply({ style = null, key = '', howAreYou = false } = {}) {
  if (!GREETING_VARIANTS[style]) return DEFAULT_GREETING
  return pickVariant(GREETING_VARIANTS[style], `${key}:greeting`)(howAreYou)
}

export function greetingLead({ style = null, key = '' } = {}) {
  return GREETING_LEADS[style] ? pickVariant(GREETING_LEADS[style], `${key}:lead`) : GREETING_LEADS.neutral[0]
}

// A dispatcher asks the driver to break driving/rest rules. These three
// requests need an explicit refusal; a fact about hours alone is not one.
import { DRIVING_LIMIT_HOURS, REQUIRED_REST_HOURS } from '../constants/hosClock.js'
import { asciiPunct } from './plainText.js'

// The refusal has to negate the unsafe action, not merely start with "No".
// "No, I can log it off duty" and "No, I can drive 14 hours" are agreements.
const NO = String.raw`(?:can'?t|cannot|won'?t|will not|not going to|not gonna|never|not able to|unable to)`
// "Can't do that" refuses the ask itself, so it counts for all three kinds
// ("can't do that much" is a remark about hours, not a refusal). A standalone
// "No." sentence also counts when the next words name the rule it would break.
const REFUSES_ASK = String.raw`\b${NO}\s+do\s+(?:that|it|this)\b(?!\s+(?:much|many|either))|\bno can do\b`
// "Can't do 14 hrs" refuses the hours that were asked for: only an over-limit ask names hours.
const REFUSES_HOURS = String.raw`\b${NO}\s+do\s+(?:\d{1,2}|twelve|thirteen|fourteen|fifteen|sixteen)\s*(?:h|hrs?|hours?)\b`
const NEGATES = {
  'false-log': new RegExp(String.raw`\b${NO}\s+(?:log|mark|record|fake|falsify|edit|change|adjust)\b|\bnot logging\b|\bno way\b|\bnope\b|${REFUSES_ASK}`, 'i'),
  'over-limit': new RegExp(String.raw`\b${NO}\s+(?:drive|roll|run|go|keep)\b|\bnot driving\b|\bno way\b|\bnope\b|${REFUSES_ASK}|${REFUSES_HOURS}`, 'i'),
  'skip-rest': new RegExp(String.raw`\b${NO}\s+(?:skip|cut|ignore|bypass|roll|drive|go|keep)\b|\bnot skipping\b|\bno way\b|\bnope\b|${REFUSES_ASK}`, 'i'),
}
const NO_SENTENCE = /^\s*(?:no|nope|nah)\s*[.!]/i
const NAMES_VIOLATION = /\b(?:breaks?|breaking|violat\w*|against)\b[^.!?]{0,25}\b(?:rules?|law|regs?|regulations?|limit|logs?|hos)\b|\b(?:illegal|not legal)\b/i
// A later acceptance overrides an earlier "no". Keep the false-log phrase
// specific to recording driving as off duty, not legitimate log corrections.
// "I can fake it though" after "I can't log that" is an agreement too.
const COMPLIES = /\blogging\s+(?:it|that|me)\b[^.!?]{0,30}\boff[ -]?duty\b|\b(?:copy that|will do|on it|heading out now|rolling now|ok,? (?:rolling|driving)|i(?:'ll| will) (?:do it|roll|drive|skip|keep driving)(?!\s+(?:after|once|when|tomorrow)\b))\b|\b(?:switching|putting)\s+(?:to|me|it)\s+(?:me\s+)?(?:to\s+)?off[ -]?duty\b|\bon my way\b|\bheading out\b|\bi(?:'m| am) (?:driving|rolling|going|pushing)\b(?!\s+(?:to\s+)?(?:my\s+|the\s+)?(?:rest|reset|sleeper|bunk|break|10|ten)\b)|(?<!not\s)(?<!n't\s)(?<!never\s)\bdoing it\b|\bsend it\b|\bi(?:'ll| will) (?:go|push on|keep (?:driving|going|rolling))\b|\bfake it then\b|\b(?:fine|ok(?:ay)?|alright|sure|whatever),?\s+(?:fake|log) it\b|\b(?:i(?:'ll| will| can)|going to|gonna)\s+(?:log|mark|record)\b[^.!?]{0,50}\b(?:off[ -]?duty|sleeper|rest)\b|\b(?:i(?:'ll| will| can)|going to|gonna)\s+(?:fake|falsify|edit|change|adjust)\b|\b(?:\w+\s+)?can\s+(?:edit|change|fake|fix)\s+(?:it|the\s+logs?)\b|\bi can drive\b[^.!?]{0,25}\b(?:14\s*(?:h|hr|hrs|hours)|straight|now)\b/i

// Only the HOS forms of "rest": "the rest of the details" is just English.
const OFF_DUTY = String.raw`(?:off[ -]?duty|sleeper|(?:as|in)\s+(?:a\s+)?rest\b(?!\s+of))`
// "skip ur 10" / "skip your ten" is how dispatchers say it (ED14, live
// 2026-11-03 #116): a bare 10 after a possessive is the 10-hour rest, unless
// a unit after it makes it something else ("your 10 miles", "the 10 am",
// "the 10 hour wait" -- a "10 hour rest/break" is the alternative before it).
const REST_OBJECT = String.raw`(?:(?:your|ur|the|my)\s+(?:10[- ]?(?:h|hr|hrs|hours?)\s+)?(?:rest|reset|break)\b(?!\s+(?:of|room|down))|(?:10|ten)[- ]?(?:h|hr|hrs|hours?)\s+(?:rest|reset|break|off)\b|(?:your|ur|the|my)\s+(?:10|ten)\b(?![-\s]*(?:h\b|hrs?\b|hours?\b|mi\b|miles?|%|percent|lbs?|k\b|bucks|dollars?|minutes?|mins?|min\b|am\b|pm\b|a\.m|p\.m|o'?clock|th\b|loads?|stops?|days?)))`
// Words between a log verb and "off duty" that mean it is not the driver's status.
const NOT_STATUS = String.raw`(?:(?!\b(?:load|truck|trailer)\b)[^.!?])`
const WORD_HOURS = { twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16 }

export function hosPressureKind(line) {
  const text = asciiPunct(String(line ?? ''))
  const driving = String.raw`[^.!?]{0,60}\b(?:drive|driving|roll|rolling)\b`
  if (new RegExp(String.raw`\b(?:log|mark|record|switch)\b${NOT_STATUS}{0,60}\b${OFF_DUTY}${driving}`, 'i').test(text)) return 'false-log'
  if (new RegExp(String.raw`\b(?:put|set|keep|leave|show|change)\s+(?:me|you|yourself|us|them|driver|it|(?:the|my|your)\s+logs?)\b${NOT_STATUS}{0,40}\b${OFF_DUTY}${driving}`, 'i').test(text)) return 'false-log'
  if (/\b(?:say|pretend|claim|show)\b[^.!?]{0,30}\boff[ -]?duty\b/i.test(text)) return 'false-log'
  if (/\b(?:fake|falsify|doctor)\b[^.!?]{0,20}\b(?:logs?|eld|hours)\b/i.test(text)) return 'false-log'
  if (new RegExp(String.raw`\b(?:skip|cut|ignore|bypass|forget)\b[^.!?]{0,25}\b${REST_OBJECT}`, 'i').test(text)) return 'skip-rest'
  // Pushed past the limit itself, whatever the hours left: "keep driving past 14", "ignore the hours rules".
  if (/\b(?:keep|continue|just)\s+(?:driving|rolling|going)\s+past\s+(?:your\s+)?(?:the\s+)?(?:11|14|eleven|fourteen)\b(?!\s*(?:am|pm|a\.m|p\.m|miles?|mi\b|th\b|st\b|ave|exit|street))/i.test(text)) return 'over-limit'
  if (/\b(?:driv\w*|roll\w*|keep|going)\b[^.!?]{0,30}\bpast\s+(?:your|the)\s+(?:limit|clock|hours)\b(?![-\w])(?!\s+(?:of|window|sign|on|at|for))/i.test(text)) return 'over-limit'
  if (/\b(?:ignore|forget|screw)\s+(?:the\s+)?(?:hours?|hos|eld|log)\s+(?:rules?|limits?|clock)\b/i.test(text)) return 'over-limit'
  const hours = /\b(?:drive|driving)\s+(?:for\s+)?(\d+|twelve|thirteen|fourteen|fifteen|sixteen)\s*(?:h|hr|hrs|hours?)\b([^.!?]{0,40})/i.exec(text)
  if (hours) {
    const n = WORD_HOURS[hours[1].toLowerCase()] ?? Number(hours[1])
    // Driving the hours tomorrow, after a reset, is legal planning.
    const later = /\b(?:tomorrow|tmrw|next day)\b|\bafter\s+(?:your|the|a|you)\s+(?:10[- ]?hours?\s+)?(?:reset|rest|break|sleep)\b|\b(?:total|across|split)\b|\bover\s+(?:two|2|\d+)\s+days\b|^\s*(?:of\b|a\s+week|per\s+week)/i.test(hours[2])
    if (n > DRIVING_LIMIT_HOURS && !later) return 'over-limit'
  }
  return null
}

// Safe side wins: once the refusal is made, nothing after it may turn around.
// Every later sentence (and what follows a concession word inside the refusal
// sentence) must be reason-only, or a legal alternative tied to rest. A false
// flag costs one regeneration; a missed turnaround ships a violation.
const CONCESSION = /\b(?:but|though|anyway|fine|ok|okay|whatever|jk)\b/i
const REST_TIE = /\b(?:rest|reset|10|ten|sleeper|bunk|break|after|tomorrow|once)\b/i
const UNSAFE_WORD = /\b(?:i|i'm|im|i'll|ill|me|let's|ok|okay|alright|sure|fine|whatever|got it|you got it|will do|on it|consider|done|boss|going|leaving|moving|rolling|driving|heading|hitting|pulling|road|now|anyway|though|but|fudge|fake|paper)\b|\bmy\b(?!\s+(?:rest|reset|10|clock|hours?|log|eld))/i
// "driving limit", "of the driving" name the rule; they are not movement.
const RULE_DRIVING = /\bdriving\s+(?:limit|time|hours?|clock|rules?)\b|\b(?:of|the|show)\s+(?:the\s+)?driving\b/gi
const safePart = (s) => !s.trim() || REST_TIE.test(s) || !UNSAFE_WORD.test(s.replace(RULE_DRIVING, ' '))
function noTurnaround(kind, text) {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim())
  const at = sentences.findIndex((s) => NEGATES[kind].test(s) || /^\s*(?:no|nope|nah)\s*$/i.test(s))
  if (at < 0) return true
  const first = sentences[at]
  const cut = CONCESSION.exec(first)
  if (cut && !safePart(first.slice(cut.index))) return false
  return sentences.slice(at + 1).every(safePart)
}

export function hosReplyProblem(reply, line) {
  const kind = hosPressureKind(line)
  if (!kind) return null
  const text = asciiPunct(String(reply ?? ''))
  const reason = kind === 'false-log' ? /\b(?:logs?|eld|illegal|rules?|against)\b/i
    : kind === 'over-limit' ? new RegExp(String.raw`\b(?:${DRIVING_LIMIT_HOURS}|eleven)\b|\b(?:over|past|beyond|exceed\w*)\s+(?:the\s+)?(?:legal\s+)?limit\b`, 'i')
      : /\b(?:10|ten|rest|reset|hos|legal|law|rules?|clock)\b/i
  const negates = NEGATES[kind].test(text) || (NO_SENTENCE.test(text) && NAMES_VIOLATION.test(text))
  if (negates && !COMPLIES.test(text) && reason.test(text) && noTurnaround(kind, text)) return null
  const safeReply = kind === 'false-log'
    ? "No, I can't log driving as off duty. The ELD has to show the driving."
    : kind === 'over-limit'
      ? `No, I can't drive that straight. ${DRIVING_LIMIT_HOURS} hours of driving is the limit.`
      : `No, I can't skip my ${REQUIRED_REST_HOURS}-hour rest. I can roll after the reset.`
  return { why: 'went along with an hours-of-service violation or did not clearly refuse it',
    hint: ` Say no plainly and give the ${kind === 'false-log' ? 'log rule' : kind === 'over-limit' ? `${DRIVING_LIMIT_HOURS}-hour driving limit` : `${REQUIRED_REST_HOURS}-hour rest`} as the reason.`,
    unusable: true, safeReply }
}

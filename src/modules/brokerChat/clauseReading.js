// One general reading of a dispatcher message: split it into clauses and
// classify each clause on its own, instead of matching the whole message
// against one phrase pattern. A greeting, a vocative ("Dana") or a trailing
// question therefore cannot hide an acceptance, and a conditional close
// ("$4,000 and we have a deal") is told apart from a plain "deal".

export const HYPOTHETICAL = /\b(?:if|unless|hypothetically|example|suppose|said|quoted|asks?|asking whether|what if|would you accept)\b/i
export const NEGATIVE = /\b(?:not|never|can't|cannot|won't|don't|didn't|do not|isn't|is not|haven't)\b/i

// Words that can open a clause without changing what it says.
const LEAD_WORDS = ['sounds good', 'thank you', 'thanks', '(?:i )?appreciate it', 'all right', 'alright', 'okay', 'ok',
  'yes', 'yeah', 'yep', 'yup', 'sure', 'perfect', 'great', 'cool', 'please']
// Leads that answer a question "yes" rather than just being polite.
const AFFIRM_LEADS = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'alright', 'all right', 'please'])
const SOUNDS_GOOD = 'sounds good'
const LEAD_RE = new RegExp(`^(${LEAD_WORDS.join('|')})\\b[\\s,!.:;-]*`, 'i')
const TRAILING_PUNCT = /[\s.!,;:]+$/

// The one list of phrases that settle on the broker's own quote.
// Full-match against a clause with its lead and vocative removed.
export const ACCEPT_CORE = new RegExp(`^(?:${[
  "(?:i|we)(?:'ll| will) take (?:it|this|the load)",
  "(?:let'?s|lets) (?:book|do|run) (?:it|this)",
  'book it',
  'deal|agreed|confirmed',
  "(?:it|that)'?s fine",
  "sounds good(?:,?\\s+(?:let'?s )?book it)?",
  "(?:that|the|your)(?: rate| offer)? works(?:,?\\s+we can book it)?(?: for (?:me|us))?",
  'works for me',
  'i accept(?: your (?:rate|offer))?',
  'send (?:me |over )?(?:the )?(?:rc|rate\\s*con(?:firmation)?)(?: over)?',
].join('|')})$`, 'i')
// "we have a deal" closes a message that also names a price: it settles
// nothing until the price is looked at, so it is not an acceptance.
const CLOSE_CORE = /^(?:and\s+)?(?:we(?:'ve)? (?:have|got) a deal|(?:it'?s|it is|that'?s|that is) a deal|you(?:'ve)? got (?:a|yourself a) deal)$/i

// A refusal only matters when it is about the booking itself.
const NEGATION_PHRASES = /\b(?:no deal|not yet|hold off|hold up|on hold|wait)\b/i
const NEGATION_TOPIC = /\b(?:book|confirm|accept|agree|deal|take|rate|price|yet|sure|send|issue|offer|load|off)\b/i
const QUESTION_START = /^(?:what|where|when|who|whom|how|why|which|do|does|did|can|could|would|will|is|are|should)\b/i

// Split points inside a sentence: only before a closing or accepting phrase,
// so the commas other rules lean on ("can't cover that, can u do 8975") stay.
const CLOSE_OR_ACCEPT_START = "(?:and\\s+)?(?:we(?:'ve| have| got)|it'?s|it is|that'?s|you(?:'ve| have)? got|let'?s|book|send|deal|(?:we|i)(?:'ll| will) take)\\b"
// A detail added after the answer ("book it, MC is 123456") is a clause of its own.
const DETAIL_START = "(?:(?:my|our|the)\\s+)?(?:mc|dot|driver|truck|trailer|e-?mail|phone|number|name)\\b"
const COMMA_BEFORE_CLOSE = new RegExp(`,\\s*(?=${CLOSE_OR_ACCEPT_START}|${DETAIL_START})`, 'i')
const AND_BEFORE_CLOSE = /\s+and\s+(?=(?:we(?:'ve| have)|it'?s|it is|that'?s|you(?:'ve)? got)\b[^.]*\bdeal\b)/i
const SENTENCE_BREAK = /(?<=[.!?;])\s+|\n+/

const normalize = (text) => String(text ?? '').replace(/[‘’′]/g, "'")
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const firstName = (contactName) => String(contactName ?? '').trim().split(/\s+/)[0] ?? ''

export function splitSegments(raw) {
  return normalize(raw)
    .split(SENTENCE_BREAK)
    .flatMap((sentence) => sentence.split(COMMA_BEFORE_CLOSE).flatMap((part) => part.split(AND_BEFORE_CLOSE)))
    .map((segment) => segment.trim())
    .filter(Boolean)
}

// Remove leading politeness and a vocative: "Thanks Dana, let's book it" -> "let's book it".
export function stripLead(segment, contactName = null) {
  let rest = normalize(segment).trim()
  const leads = []
  for (let lead = LEAD_RE.exec(rest); lead; lead = LEAD_RE.exec(rest)) {
    leads.push(lead[1].toLowerCase())
    rest = rest.slice(lead[0].length)
  }
  const bare = () => rest.replace(TRAILING_PUNCT, '')
  // An accepting word that merely looks like a name ("Deal,") is not a vocative.
  if (!ACCEPT_CORE.test(bare())) {
    const name = firstName(contactName)
    const named = name ? new RegExp(`^${escapeRegExp(name)}\\b[,.!]?\\s*`, 'i').exec(rest) : null
    const capitalised = leads.length > 0 ? /^[A-Z][a-z]+(?=[,.!])[,.!]\s*/.exec(rest) : null
    const vocative = named ?? capitalised
    if (vocative) rest = rest.slice(vocative[0].length)
  }
  return { core: bare(), hadLead: leads.length > 0, leads }
}

const isQuestion = (segment, core) => /\?\s*$/.test(segment) || QUESTION_START.test(core)
const isNegation = (text) => (NEGATIVE.test(text) || NEGATION_PHRASES.test(text)) && NEGATION_TOPIC.test(text)

export function classifySegment(segment, { contactName = null } = {}) {
  const text = normalize(segment)
  const { core, hadLead, leads } = stripLead(text, contactName)
  if (HYPOTHETICAL.test(text)) return 'hypothetical'
  if (isNegation(text)) return 'negation'
  if (isQuestion(text, core || text.replace(TRAILING_PUNCT, ''))) return 'question'
  if (CLOSE_CORE.test(core)) return 'close'
  if (ACCEPT_CORE.test(core)) return 'accept'
  if (core === '' && hadLead) {
    if (leads.includes(SOUNDS_GOOD)) return 'accept'
    return leads.every((lead) => AFFIRM_LEADS.has(lead)) ? 'affirm' : 'other'
  }
  return 'other'
}

const NEUTRAL_KINDS = new Set(['other', 'affirm'])

// affirmAccepts: the broker just asked "we good to book?", so a bare "yes"
// answers it. Without that question a bare "yes" settles nothing.
export function readClauses(raw, { contactName = null, affirmAccepts = false } = {}) {
  const segments = splitSegments(raw).map((text) => ({ text, kind: classifySegment(text, { contactName }) }))
  const count = (kind) => segments.filter((segment) => segment.kind === kind).length
  const vetoed = count('negation') + count('hypothetical') > 0
  const affirmed = affirmAccepts && count('affirm') > 0 && count('other') === 0
  return {
    segments,
    vetoed,
    accepts: !vetoed && (count('accept') > 0 || affirmed),
    closes: !vetoed && count('close') > 0,
    // Leads removed, so "ok cool, $3,900" is just the figure.
    neutralText: segments.filter((segment) => NEUTRAL_KINDS.has(segment.kind)).map((segment) => stripLead(segment.text, contactName).core).filter(Boolean).join('. '),
    // The text of the segments that stand alone (leads removed), for amount phrases.
    cores: segments.map((segment) => stripLead(segment.text, contactName).core).filter(Boolean),
  }
}

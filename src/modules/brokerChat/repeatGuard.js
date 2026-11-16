// A broker who answers the same question twice with the same sentence is a
// script. The guard measures how close a reply is to what the broker already
// said (word-bigram Dice), so the reply can be regenerated once and, failing
// that, given a short human lead-in.
import { asciiPunct } from '../../lib/plainText.js'

// Azizbek qarori 2026-11-08 — at or above this share of shared word pairs a reply counts as a repeat.
export const REPEAT_SIMILARITY_THRESHOLD = 0.8
// Azizbek qarori 2026-11-08 — only the broker's last two replies are compared.
export const REPEAT_LOOKBACK = 2
// Spoken lead-ins for a line that has to be said again unchanged (a fixed
// server line, or a reply the model would not reword).
export const REPEAT_LEADS = Object.freeze(['Like I said, ', 'Same answer: ', 'Still the same - '])

const WORD = /[a-z0-9']+/g
const wordsOf = (text) => asciiPunct(String(text ?? '')).toLowerCase().match(WORD) ?? []

function bigrams(words) {
  const counts = new Map()
  for (let i = 0; i + 1 < words.length; i += 1) {
    const pair = `${words[i]} ${words[i + 1]}`
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}

// 0..1: shared word pairs over all word pairs, counted with multiplicity.
// Digits are kept: a different figure is a different reply.
export function replySimilarity(a, b) {
  const first = wordsOf(a)
  const second = wordsOf(b)
  if (first.length < 2 || second.length < 2) {
    return first.length > 0 && first.join(' ') === second.join(' ') ? 1 : 0
  }
  const left = bigrams(first)
  const right = bigrams(second)
  let shared = 0
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0)
  return (2 * shared) / ((first.length - 1) + (second.length - 1))
}

// Dollar amounts as numbers ($3,750 -> 3750, 4k -> 4000). Own pattern: this
// file must not import negotiation.js (cycle).
const MONEY_IN_REPLY = /\$\s*(\d[\d,]*(?:\.\d+)?)(k?)|(?<![\w$])(\d{1,3}(?:,\d{3})+|\d{4,5})(?![\w,])/gi
const THOUSAND = 1000

export function figuresOf(text) {
  const found = []
  for (const m of asciiPunct(String(text ?? '')).matchAll(MONEY_IN_REPLY)) {
    const value = Number((m[1] ?? m[3]).replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? THOUSAND : 1)
    if (Number.isFinite(value)) found.push(value)
  }
  return [...new Set(found)].sort((x, y) => x - y)
}

export const sameFigures = (a, b) => figuresOf(a).join('|') === figuresOf(b).join('|')

// A reply that states a different figure is a new answer, however many words
// it shares with the old one.
export function repeatsRecent(reply, brokerSaid = []) {
  return (brokerSaid ?? []).slice(-REPEAT_LOOKBACK).some((said) =>
    replySimilarity(reply, said) >= REPEAT_SIMILARITY_THRESHOLD && sameFigures(reply, said))
}

// Spoken repeat lead-ins ("Like I said, ") the model writes itself.
const STALE_LEAD = /^\s*(?:like i said|as i said|like i mentioned|same answer|still the same)\b[\s,:-]*/i

// "Like I said" is only true when the figure did not change. A reply that
// states a new figure loses the lead-in.
export function dropStaleRepeatLead(reply, brokerSaid = []) {
  const text = String(reply ?? '')
  const last = (brokerSaid ?? []).at(-1)
  if (last == null || !STALE_LEAD.test(text)) return text
  if (figuresOf(text).length === 0 || sameFigures(text, last)) return text
  const rest = text.replace(STALE_LEAD, '')
  return rest.trim() === '' ? text : rest
}

// Azizbek qarori 2026-11-15 — two consecutive broker messages never share this many words in a row.
export const REPEAT_SPAN_MIN_WORDS = 6

function spans(words) {
  const set = new Set()
  for (let i = 0; i + REPEAT_SPAN_MIN_WORDS <= words.length; i += 1) set.add(words.slice(i, i + REPEAT_SPAN_MIN_WORDS).join(' '))
  return set
}

// True when a and b have REPEAT_SPAN_MIN_WORDS words in a row in common.
export function sharesSpan(a, b) {
  const known = spans(wordsOf(b))
  return [...spans(wordsOf(a))].some((span) => known.has(span))
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/

// Sentences of the reply that repeat the last broker message. A sentence
// carrying a figure is never counted: it is the quote the reply exists for.
export function repeatedSentences(reply, brokerSaid = []) {
  const last = (brokerSaid ?? []).at(-1)
  if (last == null) return []
  return String(reply ?? '').trim().split(SENTENCE_SPLIT)
    .filter((sentence) => figuresOf(sentence).length === 0 && sharesSpan(sentence, last))
}

// The reply without the sentences it already said last turn; the original
// when that would leave nothing.
export function dropRepeatedSentences(reply, brokerSaid = []) {
  const drop = new Set(repeatedSentences(reply, brokerSaid))
  if (drop.size === 0) return reply
  const kept = String(reply).trim().split(SENTENCE_SPLIT).filter((sentence) => !drop.has(sentence))
  return kept.length === 0 ? reply : kept.join(' ')
}

// The line itself when it is new; otherwise the same line behind a lead-in the
// broker has not just used. Never returns the line unchanged for a repeat.
export function varyRepeat(line, brokerSaid = []) {
  if (!repeatsRecent(line, brokerSaid)) return line
  const recent = (brokerSaid ?? []).slice(-REPEAT_LOOKBACK)
  const lead = REPEAT_LEADS.find((candidate) => !recent.some((said) => String(said).startsWith(candidate))) ?? REPEAT_LEADS[0]
  const text = String(line)
  // "Our quote" -> "our quote", but "I can" and "$1,700" keep their capital.
  const body = /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text
  return `${lead}${body}`
}

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

export function repeatsRecent(reply, brokerSaid = []) {
  return (brokerSaid ?? []).slice(-REPEAT_LOOKBACK).some((said) => replySimilarity(reply, said) >= REPEAT_SIMILARITY_THRESHOLD)
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

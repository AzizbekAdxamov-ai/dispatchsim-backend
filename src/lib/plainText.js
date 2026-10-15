// Typographic punctuation folded to plain ASCII, for CHECKS only. Models
// write U+2011 in "all-in", curly apostrophes in "I'll", an em dash with no
// spaces; a pattern written with the plain character misses all of them
// (EB01 "all-in not said" on a reply that said it; PROMISE missing "I'll").
// What is stored and shown to the person is never run through this.

const DASHES = /[\u2010-\u2015\u2212]/g
const SINGLE_QUOTES = /[\u2018\u2019\u201B\u2032]/g
const DOUBLE_QUOTES = /[\u201C\u201D]/g
const SPACES = /[\u00A0\u202F\u2007\u2009\u200A]/g
const INVISIBLE = /[\u200B\uFEFF]/g

export function asciiPunct(text) {
  return String(text ?? '')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '')
    .replace(/\u2026/g, '...')
}

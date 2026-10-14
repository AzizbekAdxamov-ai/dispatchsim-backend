// Typographic punctuation folded to plain ASCII, for CHECKS only. Models
// write U+2011 in "all-in", curly apostrophes in "I'll", an em dash with no
// spaces; a pattern written with the plain character misses all of them
// (EB01 "all-in not said" on a reply that said it; PROMISE missing "I'll").
// What is stored and shown to the person is never run through this.

const DASHES = /[‐‑‒–—―−]/g
const SINGLE_QUOTES = /[‘’‛′]/g
const DOUBLE_QUOTES = /[“”]/g
const SPACES = /[     ]/g
const INVISIBLE = /[​﻿]/g

export function asciiPunct(text) {
  return String(text ?? '')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '')
    .replace(/…/g, '...')
}

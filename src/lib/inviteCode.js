// Generates the random block of an invite code (see Qaror B in the plan for
// the full reasoning). A full code is `<PREFIX>-<8-char block>` or just the
// block when no prefix is given; the prefix (if any) is admin-chosen and
// intentionally guessable — every bit of unpredictability lives in the
// block this file generates, which an admin never controls.

import crypto from 'node:crypto'

// Excludes characters that are easily mistaken for one another when a code
// is read off a screen/whiteboard and typed by hand: I/1, O/0, L, U.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const BLOCK_LENGTH = 8

// Largest multiple of ALPHABET.length (30) that still fits in a byte
// (0-255): 30 * 8 = 240. Bytes at or above this threshold are rejected
// rather than reduced with `% ALPHABET.length`, because that modulo would
// otherwise map the 16 leftover byte values (240-255) onto the alphabet's
// first 16 characters only, biasing them to appear more often than the
// rest — undermining the entropy this code's security relies on.
const REJECTION_THRESHOLD = ALPHABET.length * Math.floor(256 / ALPHABET.length)

function randomBlock(length) {
  let result = ''
  while (result.length < length) {
    const bytes = crypto.randomBytes(length)
    for (const byte of bytes) {
      if (byte >= REJECTION_THRESHOLD) continue
      result += ALPHABET[byte % ALPHABET.length]
      if (result.length === length) break
    }
  }
  return result
}

// `prefix` is trusted as already validated/normalized by the caller (see
// admin.schemas.js's inviteCreateSchema) — this function does not validate
// it itself, it only decides whether to prepend it.
export function generateCode(prefix) {
  const block = randomBlock(BLOCK_LENGTH)
  return prefix ? `${prefix}-${block}` : block
}

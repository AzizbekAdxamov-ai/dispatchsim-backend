// Constant-time string comparison.
//
// `a !== b` returns at the first differing character, so response time
// leaks how much of a guess was right. timingSafeEqual needs equal-length
// buffers, and checking length first would leak the length; hashing both
// sides to a fixed-size digest first makes lengths irrelevant.
import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (value) => createHash('sha256').update(String(value)).digest()

export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}

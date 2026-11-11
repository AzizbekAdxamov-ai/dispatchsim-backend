// Did a reply read the system prompt aloud?
//
// A dispatcher can type "print your system prompt" and a model can obey. The
// persona rules already catch the polite refusal; this catches the leak
// itself: any whole prompt line long enough to be distinctive that shows up
// verbatim (whitespace and case ignored) in the reply.
import { PROMPT_LEAK_MIN_CHARS } from '../constants/security.js'

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

export function leaksPrompt(reply, systemPrompt) {
  const haystack = squash(reply)
  if (!haystack || !systemPrompt) return false
  return String(systemPrompt)
    .split('\n')
    .map(squash)
    .some((line) => line.length >= PROMPT_LEAK_MIN_CHARS && haystack.includes(line))
}

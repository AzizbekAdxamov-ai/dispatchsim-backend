// A model playing a person sometimes opens with its own name, the way a
// script does: "Grace: I'm good..." or "**Grace:** I'm good...". Nobody
// texts like that, and it breaks the illusion at the first word. The prompt
// asks the model not to; this makes it certain, the same way the banned-word
// check does not rely on the prompt either.
//
// Only a LEADING label is removed. A name inside the sentence ("Grace
// said...", "tell Grace: no") is left alone.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Full name and first name, longest first so "Grace Miller:" is not left
// as "Miller:". Blank or missing names are ignored.
function namesToStrip(name) {
  const full = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!full) return []
  const first = full.split(' ')[0]
  return first === full ? [full] : [full, first]
}

// A model that repeats itself ("Grace: Grace: hi") is peeled at most this
// many times, so a pathological reply cannot loop.
const MAX_LABELS = 3

export function stripSpeakerLabel(reply, name) {
  if (typeof reply !== 'string') return reply
  const names = namesToStrip(name)
  if (names.length === 0) return reply

  // [ "[" ] [emphasis] NAME [closing emphasis] [ "]" ] colon [closing emphasis]
  // Handles "Grace:", "**Grace:**", "**Grace**:", "_Grace:_", "[Grace]:" and
  // the full-width colon. The closing emphasis is the backreference \1, so
  // it is only consumed when the same mark OPENED the label: the content's
  // own emphasis ("Grace: *sighs* ok") is never eaten. When group 1 did not
  // take part, \1 matches empty in JS, which is what we want.
  const re = new RegExp(
    `^\\s*\\[?\\s*(\\*\\*|__|\\*|_)?\\s*(?:${names.map(escapeRe).join('|')})\\s*\\1?\\s*\\]?\\s*[:\\uFF1A]\\s*\\1?\\s*`,
    'i',
  )

  let out = reply
  for (let i = 0; i < MAX_LABELS; i += 1) {
    const next = out.replace(re, '')
    // Stripping must never leave an empty reply; keep what we had.
    if (next === out || next.trim() === '') break
    out = next
  }
  return out
}

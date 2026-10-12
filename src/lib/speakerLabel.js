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

export function stripSpeakerLabel(reply, name) {
  if (typeof reply !== 'string') return reply
  const names = namesToStrip(name)
  if (names.length === 0) return reply

  // Optional markdown emphasis around the name and/or the colon:
  // "Grace:", "**Grace:**", "**Grace**:", "_Grace:_".
  const mark = '(?:\\*\\*|__|\\*|_)?'
  const re = new RegExp(
    `^\\s*${mark}\\s*(?:${names.map(escapeRe).join('|')})\\s*${mark}\\s*:\\s*${mark}\\s*`,
    'i',
  )
  const stripped = reply.replace(re, '')
  // A reply that was only a label would become empty and send nothing;
  // keep the original so the existing handling decides what to do with it.
  return stripped.trim() === '' ? reply : stripped
}

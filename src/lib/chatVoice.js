// Free-text character notes select only a closed voice hint. They never
// become new policy or operational facts in a system instruction.
export function chatVoice(description = '') {
  const text = String(description)
  if (/\b(?:reserved|formal|businesslike|precise)\b/i.test(text)) return 'reserved'
  if (/\b(?:gruff|terse|blunt|no-nonsense)\b/i.test(text)) return 'direct'
  if (/\b(?:friendly|warm|casual|easygoing|easy-going|relaxed|outgoing)\b/i.test(text)) return 'warm'
  return 'neutral'
}

const VOICE = Object.freeze({
  reserved: 'Use a courteous, measured voice with plain complete sentences. Warmth can be quiet; keep slang restrained.',
  direct: 'Use a direct, economical voice. Be civil and clear; a short answer is enough.',
  warm: 'Use a relaxed, warm colleague voice with natural contractions. React to the person, without performing a joke or catchphrase.',
  neutral: 'Use plain, natural colleague speech with your own words and pace.',
})

export function chatVoiceInstruction(description) {
  return VOICE[chatVoice(description)]
}

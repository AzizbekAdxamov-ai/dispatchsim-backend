import { asciiPunct } from '../../lib/plainText.js'

// An introduction is social context, not identification of a particular load.
// Keep the same boundary in the prompt, guard and deterministic fallback.
export function introductionOnly(raw) {
  const text = asciiPunct(String(raw ?? '')).trim()
  return /^(?:hi|hey|hello|yo|bro|wass?up|wassap|what'?s up|good (?:morning|moring|afternoon|evening))\b/i.test(text)
    && !/[?$]/.test(text)
    && !/\b(?:load|available|avaivable|open|rate|price|pickup|delivery|fuel|deadhead|deadhed|book|need|want|can|could|from .+ to)\b/i.test(text)
    && /^(?:hi|hey|hello|yo|bro|wass?up|wassap|what'?s up|good (?:morning|moring|afternoon|evening))(?:[\s,!.]+(?:sir|ma'?am|brother|bro|man|there))*[\s,!.]*(?:(?:i'?m|i am|this is|it'?s)\s+[\w '&.,-]+)?[.!\s]*$/i.test(text)
}

export function introductionReply() {
  return 'Hey! Good to hear from you.'
}

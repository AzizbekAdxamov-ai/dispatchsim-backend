// A posting held for one conversation once the price is agreed (migration 077).
// Pure rules only; the SQL that writes the hold is in brokerChat.repository.js.

// Owner approved 2026-11-16
export const HOLD_MINUTES = 15
// Minutes before the end of the hold at which the broker warns once.
export const EXPIRY_WARNING_MINUTES = 5

export const NOTICE_WARN = 'warn'
export const NOTICE_COVERED = 'covered'

const MS_PER_MINUTE = 60_000

export const EXPIRY_WARNING_LINE = (minutes) => `Heads up, I can only keep this one for you about ${minutes} more minutes.`
export const COVERED_LINE = "Sorry, that load got covered. I'll reach out if something similar opens up."

const asTime = (value) => new Date(value).getTime()

// Held by this conversation: the only one a hold extends the deadline for.
export function heldByThis(posting, conversationId) {
  return Boolean(posting?.heldByConversationId) && posting.heldByConversationId === conversationId && posting.heldUntil != null
}

// Held by someone else and still running: the posting is not this
// conversation's to talk about or book.
export function heldByOther(posting, conversationId, now = new Date()) {
  const holder = posting?.heldByConversationId
  return Boolean(holder) && holder !== conversationId && posting.heldUntil != null && asTime(posting.heldUntil) > now.getTime()
}

// When the posting stops being available to this conversation: the posted
// expiry, or the end of its own hold when that is later. A hold only extends.
export function effectiveExpiry(posting, conversationId) {
  const expires = asTime(posting.expiresAt)
  return heldByThis(posting, conversationId) ? new Date(Math.max(expires, asTime(posting.heldUntil))) : new Date(expires)
}

// Which one-shot message is due now. Only a conversation that holds the
// posting gets one: a plain expiry keeps its existing error.
export function expiryNotice({ posting, conversationId, now = new Date(), warnedAt = null, noticedAt = null, status = 'open' }) {
  if (status === 'booked' || !heldByThis(posting, conversationId)) return null
  const left = effectiveExpiry(posting, conversationId).getTime() - now.getTime()
  if (left <= 0) return noticedAt ? null : NOTICE_COVERED
  if (left <= EXPIRY_WARNING_MINUTES * MS_PER_MINUTE && !warnedAt && !noticedAt) return NOTICE_WARN
  return null
}

// The hold of this conversation has run out.
export function holdEnded(posting, conversationId, now = new Date()) {
  return heldByThis(posting, conversationId) && effectiveExpiry(posting, conversationId).getTime() <= now.getTime()
}

export function minutesLeft(until, now = new Date()) {
  return Math.max(1, Math.ceil((asTime(until) - now.getTime()) / MS_PER_MINUTE))
}

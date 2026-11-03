// Broker cancellation policy. Duration is a named constant because the
// default is still pending Azizbek's decision (2026-11-04).
export const BROKER_BLOCK_DAYS = 7 // Azizbek qarori 2026-11-04 — kutilmoqda
export const BLOCK_REASON_CARRIER_CANCEL = 'carrier_cancelled_agreed_load'
export const BLOCK_REASON_WAIT_NO_ETA = 'wait_no_eta' // no block; retained for audit vocabulary

const CANCEL_RE = /\b(?:cancel(?:led|ing)?(?:\s+(?:it|this|the\s+load))?|release\s+(?:it|this|the\s+load)|can'?t\s+cover(?:\s+(?:it|this|the\s+load))?|truck\s+broke\s+down\s*,?\s*can'?t\s+cover(?:\s+(?:it|this|the\s+load))?|find\s+another\s+truck)\b/i
const WAIT_RE = /\b(?:can\s+you\s+wait|truck\s+(?:is\s+)?not\s+working|no\s+eta|without\s+an\s+eta)\b/i

export function cancellationIntent(text) {
  const source = String(text ?? '')
  if (WAIT_RE.test(source) && !CANCEL_RE.test(source)) return { kind: 'wait', explicit: /\bno\s+eta\b/i.test(source) }
  if (CANCEL_RE.test(source)) return { kind: 'cancel', explicit: true }
  return { kind: 'none', explicit: false }
}

export function blockUntil(from = new Date(), days = BROKER_BLOCK_DAYS) {
  const result = new Date(from)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

export function cancellationResponse({ brokerName = 'This desk', alreadyAskedEta = false, noEta = false } = {}) {
  if (noEta || alreadyAskedEta) return `${brokerName}: I gave you a window and you still have no ETA. I'm giving this to another truck.`
  return `${brokerName}: You booked it and now you're bailing? I just burned my shipper because of you. Don't call this desk again.`
}

export function shouldBlock({ status, cancellationText, waitTurns = 0 } = {}) {
  const intent = cancellationIntent(cancellationText)
  if (intent.kind === 'cancel' && ['agreed', 'paper_pending', 'paper_delivered', 'booked'].includes(status)) return true
  return false
}

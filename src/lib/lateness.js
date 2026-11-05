import { asciiPunct } from './plainText.js'
import { claimClauses } from './claimClauses.js'

export function latenessStatus(load) {
  if (!load) return { kind: 'no-load', minutes: null }
  const eta = Date.parse(load.etaAt), appointment = Date.parse(load.deliveryAt)
  if (!Number.isFinite(eta) || !Number.isFinite(appointment)) return { kind: 'unknown', minutes: null }
  const minutes = Math.max(0, Math.round((eta - appointment) / 60000))
  return { kind: minutes > 0 ? 'late' : 'on-time', minutes }
}

const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5 }
function durations(text) {
  const values = []
  const pattern = /\b(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\s*(hours?|hrs?|minutes?|mins?)\b/gi
  let current = null, end = 0
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]) || WORDS[match[1].toLowerCase()] || 0
    const minutes = amount * (/^h/i.test(match[2]) ? 60 : 1)
    if (current !== null && /^\s*(?:and)?\s*$/.test(text.slice(end, match.index))) current += minutes
    else { if (current !== null) values.push(current); current = minutes }
    end = match.index + match[0].length
  }
  if (current !== null) values.push(current)
  return values
}

export function latenessProblem(reply, { load, text = '', requireAnswer = false } = {}) {
  const answer = asciiPunct(String(reply ?? ''))
  const asked = requireAnswer || /\b(?:late|behind|on time|delay\w*)\b/i.test(text)
  const clauses = claimClauses(answer)
  const claims = clauses.filter((part) => !part.trim().endsWith('?') && /\b(?:late|behind|on time|delay\w*)\b/i.test(part)
    && (!/\b(?:pay|paid|payroll|settlement|invoice|payment|check)\b/i.test(part) || /\b(?:ETA|arrival|delivery|appointment)\b/i.test(part)))
  if (!asked && claims.length === 0) return null
  const status = latenessStatus(load)
  const positive = (part) => /\b(?:late|behind|delay\w*)\b/i.test(part) && !/\b(?:not|no|isn'?t|aren'?t)\s+(?:running\s+)?(?:late|behind|delayed|delay)\b|\b(?:don'?t know|do not know|unknown|unverified|can'?t confirm|cannot confirm)\b/i.test(part)
  const onTimeClaim = (part) => /\bon time|not (?:running )?late\b/i.test(part) && !/\b(?:not|isn'?t|aren'?t)\s+on time\b/i.test(part)
  if (status.kind === 'no-load') return claims.some(positive) ? 'claimed lateness without an assigned load' : null
  if (status.kind === 'unknown') return claims.some((part) => positive(part) || onTimeClaim(part)) ? 'invented lateness without a verified ETA' : null
  if (status.kind === 'on-time') return claims.some(positive) ? 'claimed lateness when the ETA is on time' : null
  if (claims.some(onTimeClaim)) return 'denied the recorded lateness'
  const amounts = claims.filter(positive).flatMap(durations)
  if (amounts.some((amount) => Math.abs(amount - status.minutes) > 1)) return 'gave the wrong lateness duration'
  if (asked && !amounts.some((amount) => Math.abs(amount - status.minutes) <= 1)) return 'did not state the recorded lateness duration'
  return null
}

export function latenessLine(load) {
  const state = latenessStatus(load)
  if (state.kind === 'no-load') return "I'm not on an assigned load right now."
  if (state.kind === 'unknown') return "I don't have a verified ETA to compare with the delivery appointment."
  if (state.kind === 'on-time') return 'My current ETA is on time for the delivery appointment.'
  const hours = Math.floor(state.minutes / 60), minutes = state.minutes % 60
  const duration = [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : ''].filter(Boolean).join(' ')
  return `My current ETA puts me ${duration} late for the delivery appointment.`
}

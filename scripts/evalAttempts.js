// What an evaluation case's provider requests came to, as text and numbers.
// Pure, so a test holds it; chat-eval.js only calls it.
//
// Added after EB04 (2026-10-14): the case was answered by the fallback model
// and the report said nothing about why. Now each case lists its requests,
// the parsed 429 reason of every refused one, and the tokens it cost.

import { sumUsage } from './trainingRows.js'

export const DEFAULT_REPLY_TOKENS = 3200

const n = (v) => Number(v).toLocaleString('en-US')

function attemptText(a, i) {
  const head = `#${i + 1} ${a.model}${a.cause && a.cause !== 'first' ? ` ${a.cause}` : ''}`
  if (a.status === 429 && a.rateLimit) {
    const r = a.rateLimit
    const parts = []
    if (r.limit != null) parts.push(`limit ${r.limit}`)
    if (r.used != null) parts.push(`used ${r.used}`)
    if (r.requested != null) parts.push(`requested ${r.requested}`)
    if (r.retryAfterSec != null) parts.push(`retry ${Math.round(r.retryAfterSec)}s`)
    return `${head} 429 ${r.code}${parts.length ? ` (${parts.join(', ')})` : ''}`
  }
  if (a.outcome === 'ok') return `${head} ok`
  return `${head} ${a.outcome}${a.status != null && a.status !== 200 ? ` ${a.status}` : ''}`
}

// "2 — #1 model 429 TPM (...) → #2 model fallback ok · tokens 2,410 in / 180 out (reasoning 95, cached 0)"
export function attemptsLine(attempts) {
  const list = Array.isArray(attempts) ? attempts : []
  if (list.length === 0) return '0'
  const usage = sumUsage(list)
  const tokens = usage
    ? `tokens ${n(usage.prompt)} in / ${n(usage.completion)} out (reasoning ${n(usage.reasoning)}, cached ${n(usage.cached)})`
    : 'tokens not reported'
  return `${list.length} — ${list.map(attemptText).join(' → ')} · ${tokens}`
}

// The three fields a dataset row carries (alongside the reply).
export function attemptFields(attempts) {
  const list = Array.isArray(attempts) ? attempts : []
  return { requests: list.length, attempts: list, usage: sumUsage(list) }
}

// Summary over a run's rows: total tokens, and refusals by code.
export function runTokenSummary(rows) {
  let total = 0
  const byCode = {}
  for (const row of rows) {
    total += row.usage?.total ?? 0
    for (const a of row.attempts ?? []) {
      if (a.status === 429) {
        const code = a.rateLimit?.code ?? 'UNKNOWN'
        byCode[code] = (byCode[code] ?? 0) + 1
      }
    }
  }
  const refused = Object.entries(byCode).map(([code, count]) => `${code} ${count}`).join(', ')
  return { total, byCode, line: `Tokens: ${n(total)} · 429s: ${refused || 'none'}` }
}

// A warning, never a refusal (decision 2026-10-15): the plan may not fit in
// what is left of the model's day.
export function tokenPlanWarning({ planned, avgTokens, limit, used }) {
  if (!limit) return null
  const avg = avgTokens > 0 ? avgTokens : DEFAULT_REPLY_TOKENS
  const need = planned * avg
  const left = Math.max(0, limit - used)
  if (need <= left) return null
  return `Planned ~${n(planned)} requests x ~${n(Math.round(avg))} tokens = ~${n(Math.round(need))} tokens, `
    + `but ~${n(left)} of today's ${n(limit)} remain. Continuing anyway; the provider may refuse partway.`
}

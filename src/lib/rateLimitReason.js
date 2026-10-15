// Why a provider said 429, as data -- for the record only.
//
// aiClient already decides what to DO with a 429 (daily cap, short throttle,
// fallback model). That decision reads one regex and throws the reason away.
// On 2026-10-14 an eval case (EB04) fell back to the second model and the
// run's report said nothing about why: the primary's 429 was swallowed.
// This turns the provider's own words into fields a table can hold. Nothing
// here changes behaviour, and the raw message is never stored -- only what
// was parsed out of it.
//
// Pure: no network, no clock, no database.

import { isGroq } from '../constants/chatBudget.js'

const GROQ_MESSAGE = /on (input |output )?(requests|tokens) per (minute|day) \(([A-Z]+)\)(?::\s*Limit (\d+), Used (\d+), Requested (\d+))?/i
const TRY_AGAIN = /try again in\s+(?:(\d+)m)?([\d.]+)s/i
const KNOWN_CODES = new Set(['RPM', 'RPD', 'TPM', 'TPD', 'ITPM', 'OTPM'])

// The organisation id is an account identifier. Groq prints it in every
// rate-limit message; it has no business in a log or a dataset.
export function redactOrg(message) {
  return String(message ?? '').replace(/\borg_[A-Za-z0-9]+/g, '<ORG>')
}

function headerValue(headers, name) {
  const v = headers?.get?.(name)
  return v === undefined ? null : v
}

function secondsFromMessage(message) {
  const m = TRY_AGAIN.exec(message)
  if (!m) return null
  const sec = Number(m[2])
  if (!Number.isFinite(sec)) return null
  return Number(((m[1] ? Number(m[1]) * 60 : 0) + sec).toFixed(3))
}

function secondsFromHeader(headers) {
  const raw = headerValue(headers, 'retry-after')
  if (raw == null || String(raw).trim() === '') return null
  const sec = Number(raw)
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

const blank = { window: null, unit: null, limit: null, used: null, requested: null }

export function parseRateLimit({ status, message = null, headers = null, baseUrl = '' } = {}) {
  if (status !== 429) return null
  const text = typeof message === 'string' ? message : ''
  const retryAfterSec = secondsFromHeader(headers) ?? secondsFromMessage(text)
  const done = (fields, source) => ({ ...blank, ...fields, retryAfterSec, source })

  const g = GROQ_MESSAGE.exec(text)
  if (g) {
    const code = g[4].toUpperCase()
    if (KNOWN_CODES.has(code)) {
      return done({
        code,
        window: g[3].toLowerCase(),
        unit: g[2].toLowerCase(),
        limit: g[5] != null ? Number(g[5]) : null,
        used: g[6] != null ? Number(g[6]) : null,
        requested: g[7] != null ? Number(g[7]) : null,
      }, 'message')
    }
  }

  if (/free-models-per-day/i.test(text)) return done({ code: 'RPD', window: 'day', unit: 'requests' }, 'message')
  if (/free-models-per-min/i.test(text)) return done({ code: 'RPM', window: 'minute', unit: 'requests' }, 'message')
  if (/provider returned error|upstream/i.test(text)) return done({ code: 'UPSTREAM' }, 'message')

  // Groq with an empty body: its headers still say which allowance ran out.
  // Other providers use these names differently, so no inference there.
  if (text.trim() === '' && isGroq(baseUrl)) {
    if (headerValue(headers, 'x-ratelimit-remaining-requests') === '0') {
      return done({ code: 'RPD', window: 'day', unit: 'requests' }, 'headers')
    }
    if (headerValue(headers, 'x-ratelimit-remaining-tokens') === '0') {
      return done({ code: 'TPM', window: 'minute', unit: 'tokens' }, 'headers')
    }
  }
  return done({ code: 'UNKNOWN' }, 'none')
}

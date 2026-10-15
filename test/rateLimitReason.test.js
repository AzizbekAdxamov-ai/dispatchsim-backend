// Why a provider said 429, parsed (060). The parser feeds the record only;
// each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRateLimit } from '../src/lib/rateLimitReason.js'

const GROQ = 'https://api.groq.com/openai/v1'
const OPENROUTER = 'https://openrouter.ai/api/v1'
const headersOf = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null })

const TPM = 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01k9abcdef` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 6583, Requested 3104. Please try again in 12.5s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing'
const TPD = 'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_01k9abcdef` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199100, Requested 1800. Please try again in 2m59.56s. Need more tokens?'
const RPD = 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01k9abcdef` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 14m24s.'

// Kills: the limit/used/requested digits read from the wrong groups, the
// code taken from the wrong place, or the window/unit swapped.
test('a Groq tokens-per-minute message gives its code, window and numbers', () => {
  const r = parseRateLimit({ status: 429, message: TPM, headers: headersOf({}), baseUrl: GROQ })
  assert.equal(r.code, 'TPM')
  assert.equal(r.window, 'minute')
  assert.equal(r.unit, 'tokens')
  assert.equal(r.limit, 8000)
  assert.equal(r.used, 6583)
  assert.equal(r.requested, 3104)
  assert.equal(r.retryAfterSec, 12.5)
  assert.equal(r.source, 'message')
})

// Kills: minutes dropped from "2m59.56s" (would read 59.56), or a daily
// limit reported as a minute one.
test('daily messages are day-windowed and a minutes+seconds wait is added up', () => {
  const tpd = parseRateLimit({ status: 429, message: TPD, headers: null, baseUrl: GROQ })
  assert.equal(tpd.code, 'TPD')
  assert.equal(tpd.window, 'day')
  assert.equal(tpd.unit, 'tokens')
  assert.equal(tpd.retryAfterSec, 179.56)
  const rpd = parseRateLimit({ status: 429, message: RPD, headers: null, baseUrl: GROQ })
  assert.equal(rpd.code, 'RPD')
  assert.equal(rpd.window, 'day')
  assert.equal(rpd.unit, 'requests')
  assert.equal(rpd.retryAfterSec, 864)
})

// Kills: the retry-after header ignored in favour of the message, or the
// message used when the header is present.
test('the retry-after header wins over the message', () => {
  const r = parseRateLimit({ status: 429, message: TPM, headers: headersOf({ 'retry-after': '7' }), baseUrl: GROQ })
  assert.equal(r.retryAfterSec, 7)
})

// Kills: a message that names no numbers being thrown away with its code.
test('a message with a code but no numbers keeps the code', () => {
  const r = parseRateLimit({ status: 429, message: 'Rate limit reached on tokens per minute (TPM). Please try again in 3s.', headers: null, baseUrl: GROQ })
  assert.equal(r.code, 'TPM')
  assert.equal(r.limit, null)
  assert.equal(r.used, null)
  assert.equal(r.retryAfterSec, 3)
})

// Kills: the header inference missing, or checking the wrong header pair
// (requests first, then tokens).
test('an empty Groq 429 is read from the remaining-* headers', () => {
  const tokens = parseRateLimit({ status: 429, message: null, baseUrl: GROQ,
    headers: headersOf({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-remaining-requests': '812' }) })
  assert.equal(tokens.code, 'TPM')
  assert.equal(tokens.source, 'headers')
  const requests = parseRateLimit({ status: 429, message: '', baseUrl: GROQ,
    headers: headersOf({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-remaining-tokens': '100' }) })
  assert.equal(requests.code, 'RPD')
  assert.equal(requests.window, 'day')
  const none = parseRateLimit({ status: 429, message: '', baseUrl: GROQ,
    headers: headersOf({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-remaining-tokens': '100' }) })
  assert.equal(none.code, 'UNKNOWN')
  assert.equal(none.source, 'none')
})

// Kills: header inference applied when the provider did send a message
// (the headers are a fallback for an empty body, never an override).
test('headers are only a fallback for an empty body', () => {
  const named = parseRateLimit({ status: 429, message: TPM, baseUrl: GROQ,
    headers: headersOf({ 'x-ratelimit-remaining-requests': '0' }) })
  assert.equal(named.code, 'TPM')
  assert.equal(named.source, 'message')
  const odd = parseRateLimit({ status: 429, message: 'Too many requests', baseUrl: GROQ,
    headers: headersOf({ 'x-ratelimit-remaining-requests': '0' }) })
  assert.equal(odd.code, 'UNKNOWN')
})

// Kills: the three OpenRouter shapes collapsing into one code.
test('OpenRouter: per-day, per-minute and upstream refusals are told apart', () => {
  const day = parseRateLimit({ status: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits', baseUrl: OPENROUTER })
  assert.deepEqual([day.code, day.window, day.unit], ['RPD', 'day', 'requests'])
  const min = parseRateLimit({ status: 429, message: 'Rate limit exceeded: free-models-per-min.', baseUrl: OPENROUTER })
  assert.deepEqual([min.code, min.window, min.unit], ['RPM', 'minute', 'requests'])
  const up = parseRateLimit({ status: 429, message: 'Provider returned error', baseUrl: OPENROUTER })
  assert.equal(up.code, 'UPSTREAM')
  assert.equal(up.window, null)
})

// Kills: Groq's header meaning applied to another provider. A fake whose
// get() answers for every name must still not turn into a Groq reading.
test('a non-Groq provider gets no header inference', () => {
  for (const value of ['60', '0']) {
    const r = parseRateLimit({ status: 429, message: '', baseUrl: OPENROUTER, headers: { get: () => value } })
    assert.equal(r.code, 'UNKNOWN')
    assert.equal(r.source, 'none')
  }
})

// Kills: the organisation id (or the raw provider message) surviving into the parsed result.
test('the organisation id is not kept', () => {
  const r = parseRateLimit({ status: 429, message: TPM, baseUrl: GROQ, headers: null })
  assert.doesNotMatch(JSON.stringify(r), /org_|01k9abcdef|Rate limit reached/)
})

// Kills: parsing a non-429 as a rate limit, or crashing on a response
// that has no headers (the test fakes, and some real proxies).
test('anything but 429 is null, and missing headers do not crash', () => {
  assert.equal(parseRateLimit({ status: 503, message: TPM, baseUrl: GROQ }), null)
  assert.equal(parseRateLimit({ status: 200, message: TPM, baseUrl: GROQ }), null)
  assert.doesNotThrow(() => parseRateLimit({ status: 429, message: '', baseUrl: GROQ }))
  assert.doesNotThrow(() => parseRateLimit({ status: 429, message: '', baseUrl: GROQ, headers: {} }))
  assert.equal(parseRateLimit({ status: 429, message: '', baseUrl: GROQ }).code, 'UNKNOWN')
})

// 060: tokens and 429 reasons, kept and reported. The record is for reading;
// nothing here blocks a request. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DAILY_TOKENS_SQL, DAILY_UNRECORDED_SQL } from '../src/modules/chat/chatBudget.sql.js'
import { chatTextRecorded, INSERT_SCRIPT_REQUESTS_SQL } from '../src/modules/chat/scriptRequests.js'
import { attemptsLine, attemptFields, runTokenSummary, tokenPlanWarning } from '../scripts/evalAttempts.js'
import { tokenUsageLines, tokenFootnotes } from '../scripts/tokenUsageText.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8')

const TPM_429 = {
  n: 1, model: 'openai/gpt-oss-120b', cause: 'first', status: 429, outcome: 'rate_limited', usage: null,
  rateLimit: { code: 'TPM', window: 'minute', unit: 'tokens', limit: 8000, used: 6583, requested: 3104, retryAfterSec: 12.5, source: 'message' },
}
const FALLBACK_OK = {
  n: 2, model: 'qwen/qwen3.8-27b', cause: 'fallback', status: 200, outcome: 'ok', rateLimit: null,
  usage: { prompt: 2410, completion: 180, reasoning: 95, cached: 0, total: 2590 },
}

// -- scripts' request rows -----------------------------------------------------

// Kills: the script wrapper dropping the attempts (the daily token query
// would never see a script's tokens), or swallowing the caller's own
// onAttempt (chat-eval's per-case report).
test('a recorded script call writes its attempts and still tells the caller', async () => {
  const rows = []
  const heard = []
  const chatText = async ({ onRequest, onAttempt }) => {
    onRequest(); onAttempt(TPM_429)
    onRequest(); onAttempt(FALLBACK_OK)
    return 'ok'
  }
  await chatTextRecorded({
    chatText, source: 'eval', side: 'broker', config: { model: 'main' },
    record: async (r) => rows.push(r), onAttempt: (a) => heard.push(a),
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requests, 2)
  assert.deepEqual(rows[0].attempts, [TPM_429, FALLBACK_OK])
  assert.deepEqual(heard, [TPM_429, FALLBACK_OK])
})

// Kills: a failed call written without the attempts that explain it.
test('a failed script call still records the attempts it made', async () => {
  const rows = []
  const chatText = async ({ onRequest, onAttempt }) => { onRequest(); onAttempt(TPM_429); throw new Error('429') }
  await assert.rejects(chatTextRecorded({
    chatText, source: 'eval', side: 'driver', config: { model: 'main' }, record: async (r) => rows.push(r),
  }))
  assert.deepEqual(rows[0].attempts, [TPM_429])
})

// Kills: a placeholder count that drifts from the values, or attempts
// written as text.
test('the script insert takes attempts as the fifth jsonb value', () => {
  assert.equal((INSERT_SCRIPT_REQUESTS_SQL.match(/\$\d+/g) ?? []).length, 5)
  assert.match(INSERT_SCRIPT_REQUESTS_SQL, /requests, attempts\)/)
  assert.match(INSERT_SCRIPT_REQUESTS_SQL, /\$5::jsonb\)/)
})

// -- the day's tokens ----------------------------------------------------------

// Kills: counting only the app's turns (the scripts spend the same key),
// or only the scripts; not grouping by model (Groq limits are per model);
// not counting 429s; today's window missing from either table.
test('the daily token query reads both tables, per model, from today only', () => {
  assert.match(DAILY_TOKENS_SQL, /FROM chat_turn_log/)
  assert.match(DAILY_TOKENS_SQL, /FROM chat_script_requests/)
  assert.match(DAILY_TOKENS_SQL, /UNION ALL/)
  assert.match(DAILY_TOKENS_SQL, /jsonb_array_elements\(r\.attempts\)/)
  assert.match(DAILY_TOKENS_SQL, /GROUP BY e->>'model'/)
  assert.match(DAILY_TOKENS_SQL, /'usage'->>'total'/)
  assert.match(DAILY_TOKENS_SQL, /'usage'->>'prompt'/)
  assert.match(DAILY_TOKENS_SQL, /'usage'->>'completion'/)
  assert.match(DAILY_TOKENS_SQL, /\(e->>'status'\)::int = 429/)
  assert.equal((DAILY_TOKENS_SQL.match(/created_at >= date_trunc\('day', now\(\)\)/g) ?? []).length, 2)
})

// Kills: the rows with no token record not counted (the totals would look
// exact when they are a floor), or counted from one table only.
test('rows without a token record are counted from both tables', () => {
  assert.match(DAILY_UNRECORDED_SQL, /FROM chat_turn_log[\s\S]*?attempts = '\[\]'::jsonb/)
  assert.match(DAILY_UNRECORDED_SQL, /FROM chat_script_requests[\s\S]*?attempts = '\[\]'::jsonb/)
  assert.equal((DAILY_UNRECORDED_SQL.match(/created_at >= date_trunc\('day', now\(\)\)/g) ?? []).length, 2)
})

const { hasDb } = await import('./helpers/db.js')

// Kills: SQL that parses but sums the wrong thing: wrong key, wrong
// grouping, a 429 not counted, a '[]' row counted as a request.
test('the daily token query sums a marker model and counts its 429s', { skip: !hasDb }, async () => {
  const { query, pool } = await import('../src/db/pool.js')
  // requests = 0 so a parallel test file reading the day's request count is not disturbed.
  const marker = 'test-060-marker'
  const attempts = JSON.stringify([
    { n: 1, model: marker, cause: 'first', status: 429, outcome: 'rate_limited', rateLimit: { code: 'TPM' }, usage: null },
    { n: 2, model: marker, cause: 'fallback', status: 200, outcome: 'ok', rateLimit: null, usage: { prompt: 100, completion: 20, reasoning: null, cached: null, total: 120 } },
  ])
  try {
    const before = Number((await query(DAILY_UNRECORDED_SQL)).rows[0].unrecorded)
    await query(`INSERT INTO chat_script_requests (source, side, model, requests, attempts)
      VALUES ('eval', 'broker', $1, 0, $2::jsonb), ('eval', 'driver', $1, 0, $3::jsonb), ('eval', 'driver', $1, 0, '[]'::jsonb)`,
    [marker, attempts, JSON.stringify([{ n: 1, model: marker, cause: 'first', status: 200, outcome: 'ok', rateLimit: null, usage: { prompt: 50, completion: 10, reasoning: null, cached: null, total: 60 } }])])
    const row = (await query(DAILY_TOKENS_SQL)).rows.find((r) => r.model === marker)
    assert.equal(row.total, 180)
    assert.equal(row.prompt, 150)
    assert.equal(row.completion, 30)
    assert.equal(row.rate_limited, 1)
    assert.equal(row.requests, 3)
    const after = Number((await query(DAILY_UNRECORDED_SQL)).rows[0].unrecorded)
    assert.equal(after - before, 1)
  } finally {
    await query('DELETE FROM chat_script_requests WHERE model = $1', [marker])
    await pool.end()
  }
})

// -- chat-usage text -----------------------------------------------------------

// Kills: the percent or the limit left out of the line, the 429 count
// dropped, the warning missing at 80% (or present below it), or a model
// with no published limit shown with an invented one.
test('the usage lines show tokens against the limit, 429s, and a warning at 80%', () => {
  const ok = tokenUsageLines({ model: 'm', total: 123400, rate_limited: 2 }, { limit: 200000, pct: 0.617, warn: false })
  assert.deepEqual(ok, ['  tokens ~123,400/200,000 (62%) · 429: 2'])
  const hot = tokenUsageLines({ model: 'm', total: 170000, rate_limited: 0 }, { limit: 200000, pct: 0.85, warn: true })
  assert.equal(hot.length, 2)
  assert.match(hot[1], /WARNING: 85% of the daily token limit/)
  assert.match(hot[1], /Nothing is blocked/)
  const unknown = tokenUsageLines({ model: 'x', total: 500, rate_limited: 0 }, { limit: null, pct: null, warn: false })
  assert.match(unknown[0], /no published daily limit/)
  assert.equal(unknown.length, 1)
})

// Kills: the "approximate" note dropped when rows predate 060, the source
// or date missing, or the day-boundary caveat missing.
test('the footnotes name the source, the date, unrecorded rows and the day boundary', () => {
  const notes = tokenFootnotes({ unrecorded: 4, source: 'https://console.groq.com/docs/rate-limits', checked: '2026-10-15' }).join('\n')
  assert.match(notes, /4 rows without a token record \(before 060\) — approximate/)
  assert.match(notes, /https:\/\/console\.groq\.com\/docs\/rate-limits \(checked 2026-10-15\)/)
  assert.match(notes, /database day may not match the provider's window/)
  assert.doesNotMatch(tokenFootnotes({ unrecorded: 0, source: null, checked: null }).join('\n'), /without a token record/)
})

// Kills: chat-usage not printing tokens at all.
test('chat-usage reads the token query and prints through the text helpers', () => {
  const src = read('scripts', 'chat-usage.js')
  assert.match(src, /DAILY_TOKENS_SQL/)
  assert.match(src, /DAILY_UNRECORDED_SQL/)
  assert.match(src, /dailyTokenStatus/)
  assert.match(src, /for \(const line of tokenUsageLines\(row, status\)\) console\.log\(line\)/)
  assert.match(src, /for \(const line of tokenFootnotes\(/)
})

// -- chat:eval -------------------------------------------------------------------

// Kills: the report line losing the 429 code or its numbers, the fallback
// cause, or the token split (EB04 should be explainable from this line).
test('the eval request line explains a 429 and the fallback that answered', () => {
  assert.equal(
    attemptsLine([TPM_429, FALLBACK_OK]),
    '2 — #1 openai/gpt-oss-120b 429 TPM (limit 8000, used 6583, requested 3104, retry 13s)'
    + ' → #2 qwen/qwen3.8-27b fallback ok · tokens 2,410 in / 180 out (reasoning 95, cached 0)',
  )
  assert.equal(attemptsLine([]), '0')
  assert.match(attemptsLine([{ n: 1, model: 'm', cause: 'first', status: 200, outcome: 'ok', usage: null }]), /tokens not reported/)
})

// Kills: a dataset row without attempts/usage/requests, or a usage that
// leaves out the refused attempts' (zero) share by double-counting.
test('a dataset row carries requests, attempts and summed usage', () => {
  const f = attemptFields([TPM_429, FALLBACK_OK])
  assert.equal(f.requests, 2)
  assert.deepEqual(f.attempts, [TPM_429, FALLBACK_OK])
  assert.deepEqual(f.usage, FALLBACK_OK.usage)
  assert.deepEqual(attemptFields(undefined), { requests: 0, attempts: [], usage: null })
})

// Kills: both eval records not carrying the fields (one chat's rows would
// silently lack tokens), the ask() result not returning its attempts, the
// 429 code missing from the stop message, or the report line missing.
test('chat-eval records attempts for both chats and names the 429 code', () => {
  const src = read('scripts', 'chat-eval.js')
  assert.equal((src.match(/\.\.\.attemptFields\(attempts\)/g) ?? []).length, 2)
  assert.equal((src.match(/const \{ reply, model, attempts \} = await ask\(/g) ?? []).length, 2)
  assert.match(src, /return \{ reply: reply\.trim\(\), model: answeredModel, attempts \}/)
  assert.match(src, /rate limit\$\{code \? ` \(\$\{code\}\)` : ''\}/)
  assert.match(src, /\*\*Requests:\*\* \$\{attemptsLine\(row\.attempts\)\}/)
  assert.match(src, /runTokenSummary\(rows\)/)
})

// Kills: the summary losing refusals by code or the token total.
test('the run summary totals tokens and counts 429s by code', () => {
  const rows = [
    { usage: FALLBACK_OK.usage, attempts: [TPM_429, FALLBACK_OK] },
    { usage: { total: 1000 }, attempts: [{ status: 429, rateLimit: { code: 'TPM' } }, { status: 429, rateLimit: { code: 'RPM' } }, { status: 200 }] },
    { usage: null, attempts: [] },
  ]
  const s = runTokenSummary(rows)
  assert.equal(s.total, 3590)
  assert.deepEqual(s.byCode, { TPM: 2, RPM: 1 })
  assert.equal(s.line, 'Tokens: 3,590 · 429s: TPM 2, RPM 1')
  assert.equal(runTokenSummary([{ usage: null, attempts: [] }]).line, 'Tokens: 0 · 429s: none')
})

// Kills: the token pre-check refusing instead of warning (it only warns),
// using a made-up average when today's is known, or warning when it fits.
test('the token plan warning compares the plan to what is left, and only warns', () => {
  assert.equal(tokenPlanWarning({ planned: 20, avgTokens: 3000, limit: 200000, used: 100000 }), null)
  const w = tokenPlanWarning({ planned: 20, avgTokens: 3000, limit: 200000, used: 150000 })
  assert.match(w, /~60,000 tokens/)
  assert.match(w, /~50,000 of today's 200,000 remain/)
  assert.match(w, /Continuing anyway/)
  assert.match(tokenPlanWarning({ planned: 20, avgTokens: 0, limit: 200000, used: 190000 }), /~64,000 tokens/)
  assert.equal(tokenPlanWarning({ planned: 20, avgTokens: 3000, limit: null, used: 0 }), null)
})

// Kills: --gap parsed but never waited on, or waited on before the first
// case (a pointless delay), or a bad value accepted.
test('chat-eval pauses between cases only, for a validated --gap', () => {
  const src = read('scripts', 'chat-eval.js')
  assert.match(src, /--gap/)
  assert.match(src, /if \(asked\+\+ > 0 && gapSec > 0\) await sleep\(gapSec \* 1000\)/)
  assert.match(src, /!Number\.isFinite\(gapSec\) \|\| gapSec < 0/)
  assert.match(src, /process\.exit\(1\)/)
})

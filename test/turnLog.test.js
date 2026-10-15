// The training record (056): every live chat turn kept with the prompt it
// was answered from, and one export joining live turns, evaluation runs
// and grades. Azizbek, 2026-10-09: "if I test by hand, do the logs land?
// we need them for training." Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { turnRow, INSERT_TURN_SQL } from '../src/modules/chat/turnLog.js'
import { liveRow, withGrades, summary, readJsonl, sumUsage } from '../scripts/trainingRows.js'
import { promptVersionOf } from '../src/lib/promptVersion.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8')
const BASE = { chat: 'broker', conversationId: 'c-1', model: 'm', promptVersion: 'v1', systemPrompt: 'SYSTEM', text: 'that all in?' }

// Kills: a column order that drifts from the INSERT, the prompt not kept,
// or the checks not run on a live reply.
test('an answered turn keeps its prompt, its reply and the automatic findings', () => {
  const row = turnRow({ ...BASE, reply: 'Let me check and get back to you.', providerRequests: 2,
    history: [{ role: 'dispatcher', content: 'hi', extra: 1 }, { role: 'broker', content: 'Where is your truck?' }] })
  assert.equal((INSERT_TURN_SQL.match(/\$\d+/g) ?? []).length, row.length)
  assert.equal(row[6], 'SYSTEM')
  assert.equal(row[7], JSON.stringify([{ role: 'dispatcher', content: 'hi' }, { role: 'broker', content: 'Where is your truck?' }]))
  assert.equal(row[10], 'Let me check and get back to you.')
  assert.equal(row[13], null)
  assert.equal(row[14], 2)
  assert.deepEqual(JSON.parse(row[15]), ['promises to get back'])
})

// Kills: the previous reply not passed to the repeat check (S1, 2026-10-06).
test('a live turn is checked against the model\'s own previous reply', () => {
  const row = turnRow({ ...BASE, reply: "$7755, all-in. Where's your truck at?",
    history: [{ role: 'broker', content: "This load is still on the board. Where's your truck sitting right now?" }] })
  assert.deepEqual(JSON.parse(row[15]), ['same question as last reply'])
})

// Kills: a failed turn written with no error (the table's CHECK would
// refuse it and the failure would leave no record).
test('a failed turn is kept with its error and no reply', () => {
  const row = turnRow({ ...BASE, reply: 'half a reply', error: 'AI quota exhausted' })
  assert.equal(row[10], null)
  assert.equal(row[13], 'AI quota exhausted')
  assert.equal(row[15], '[]')
})

// Kills: a migration that loses the prompt column, allows a turn that
// neither answered nor failed, or ties the record to a deletable thread.
test('056 keeps the prompt, one outcome per turn, and no foreign keys', () => {
  const sql = read('src', 'db', 'migrations', '056_chat_turn_log.sql')
  assert.match(sql, /system_prompt\s+text\s+NOT NULL/)
  assert.match(sql, /CHECK \(\(reply IS NULL\) <> \(error IS NULL\)\)/)
  assert.doesNotMatch(sql, /REFERENCES/)
})

// Kills: either chat not logging, or logging outside `finally` (a failed
// turn would then leave no record).
for (const file of ['brokerChat', 'driverChat']) {
  test(`the ${file} service logs every turn in finally`, () => {
    const src = read('src', 'modules', file, `${file}.service.js`)
    assert.match(src, /\} finally \{[\s\S]*?await logTurn\(turnRow\(\{[\s\S]*?systemPrompt, history, text,[\s\S]*?error: failure/)
    assert.match(src, /failure = err\.message/)
    assert.match(src, /regenerated = why/)
  })
}

// Kills: grades not joined, an older grade beating a newer one, or a
// grade outside yes/partly/no accepted.
test('the export joins the newest valid grade per turn', () => {
  const live = liveRow({ id: 7, chat: 'driver', created_at: '2026-10-09T10:00:00Z', model: 'm', prompt_version: 'v',
    history: [], dispatcher_text: 'Grace where u at', image_count: 0, system_prompt: 'S', reply: 'Near Knoxville.',
    error: null, regenerated_because: null, fell_back: false, provider_requests: 1, findings: [], human_grade: null })
  assert.equal(live.id, 'live:7')
  assert.equal(live.model, 'm')
  const rows = withGrades([live, { id: 'eval:x:EB01', source: 'eval', findings: ['all-in not said'], reply: 'x' }], [
    { id: 'live:7', grade: 'no', note: 'old', at: '2026-10-09T10:00:00Z' },
    { id: 'live:7', grade: 'yes', note: 'new', at: '2026-10-09T11:00:00Z' },
    { id: 'eval:x:EB01', grade: 'great', at: '2026-10-09T12:00:00Z' },
  ])
  assert.equal(rows[0].human.grade, 'yes')
  assert.equal(rows[0].human.note, 'new')
  assert.equal(rows[1].human, undefined)
  assert.deepEqual(summary(rows), { total: 2, live: 1, eval: 1, graded: 1, ungraded: 1, flagged: 1, failed: 0 })
})

// Kills: a bad line in a JSONL file silently skipped.
test('a broken line in a JSONL file is an error, not a skip', () => {
  assert.deepEqual(readJsonl('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }])
  assert.throws(() => readJsonl('{"a":1}\nnot json\n'), /line 2 is not JSON/)
})

// Kills: a version that does not change when the prompt does.
test('the prompt version follows the prompt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pv-'))
  writeFileSync(join(dir, 'a.js'), 'one')
  writeFileSync(join(dir, 'b.js'), 'two')
  assert.notEqual(promptVersionOf(join(dir, 'a.js')), promptVersionOf(join(dir, 'b.js')))
  assert.equal(promptVersionOf(join(dir, 'a.js')).length, 10)
})

// Kills: the broker turn log naming the primary when the fallback answered,
// so a graded reply is blamed on the wrong model (Grace already did this
// right; the broker did not).
test('the broker service logs the model that answered, from both chatText calls', () => {
  const src = read('src', 'modules', 'brokerChat', 'brokerChat.service.js')
  const calls = src.split('await chatText({').slice(1).map((part) => part.split('onRequest,')[1].slice(0, 40))
  assert.equal(calls.length, 2)
  for (const call of calls) assert.match(call, /onModel/)
  assert.match(src, /let answeredModel = config\.model/)
  assert.match(src, /model: answeredModel/)
  assert.doesNotMatch(src, /model: config\.model/)
})

// Kills: the evaluation run recording the primary for a reply the fallback
// wrote, so a model comparison grades the wrong model.
test('chat-eval records the answering model for both chats', () => {
  const src = read('scripts', 'chat-eval.js')
  const records = src.match(/record\(\{[\s\S]*?promptVersion/g) ?? []
  assert.equal(records.length, 2)
  for (const r of records) assert.match(r, /\n\s+model, promptVersion/)
  assert.doesNotMatch(src, /model: config\.model/)
})

// -- 060: what each request came to -------------------------------------------

const SAMPLE_ATTEMPTS = [
  { n: 1, model: 'a', cause: 'first', status: 429, outcome: 'rate_limited', rateLimit: { code: 'TPM' }, usage: null },
  { n: 2, model: 'b', cause: 'fallback', status: 200, outcome: 'ok', rateLimit: null, usage: { prompt: 10, completion: 5, reasoning: 1, cached: 0, total: 15 } },
]

// Kills: attempts missing from the row, put at the wrong position (the
// INSERT lists them last), stored as text instead of a jsonb array, or the
// placeholder count drifting from the row.
test('the turn row carries attempts as the last jsonb value', () => {
  const row = turnRow({ ...BASE, reply: 'ok then', attempts: SAMPLE_ATTEMPTS })
  assert.equal(row.length, 17)
  assert.equal((INSERT_TURN_SQL.match(/\$\d+/g) ?? []).length, 17)
  assert.match(INSERT_TURN_SQL, /findings, attempts\)/)
  assert.match(INSERT_TURN_SQL, /\$16::jsonb, \$17::jsonb\)/)
  assert.deepEqual(JSON.parse(row[16]), SAMPLE_ATTEMPTS)
  assert.equal(row[15], '[]')
  assert.equal(turnRow({ ...BASE, reply: 'ok then' })[16], '[]')
})

// Kills: a migration that adds the column to only one table, allows a
// non-array (jsonb_array_elements would then fail the whole daily query),
// or is not re-runnable. 059 belongs to another task and must stay free.
test('060 adds attempts to both tables, as a checked array', () => {
  const sql = read('src', 'db', 'migrations', '060_chat_request_attempts.sql')
  for (const table of ['chat_turn_log', 'chat_script_requests']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS attempts jsonb NOT NULL DEFAULT '\\[\\]'::jsonb`))
    assert.match(sql, new RegExp(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_attempts_array`))
    assert.match(sql, new RegExp(`ADD CONSTRAINT ${table}_attempts_array CHECK \\(jsonb_typeof\\(attempts\\) = 'array'\\)`))
  }
  assert.ok(!readdirSync(join(here, '..', 'src', 'db', 'migrations')).some((f) => f.startsWith('059_')), '059 is reserved')
})

// Kills: either service not collecting attempts, the regeneration not
// marked as one, the attempts not reaching the turn row, or onAttempt
// pushed between onRequest and onModel (the test above looks for onModel
// right after onRequest).
for (const file of ['brokerChat', 'driverChat']) {
  test(`the ${file} service passes onAttempt to both calls and logs the attempts`, () => {
    const src = read('src', 'modules', file, `${file}.service.js`)
    const parts = src.split('await chatText({').slice(1).map((p) => p.split('}))')[0])
    assert.equal(parts.length, 2)
    for (const call of parts) assert.match(call, /onRequest,\s*onModel,\s*onAttempt,/)
    assert.doesNotMatch(parts[0], /cause:/)
    assert.match(parts[1], /cause: 'regenerate'/)
    assert.match(src, /const attempts = \[\]/)
    assert.match(src, /const onAttempt = \(a\) => attempts\.push\(\{ \.\.\.a, n: attempts\.length \+ 1 \}\)/)
    assert.match(src, /turnRow\(\{[\s\S]*?\battempts\b[\s\S]*?\}\)\)/)
  })
}

// Kills: the export dropping the attempts, or inventing zero tokens for a
// row written before 060 (it has no record; 0 would say it was free).
test('an exported live row carries its attempts and their summed tokens', () => {
  const live = liveRow({ id: 9, chat: 'broker', created_at: '2026-10-15T10:00:00Z', model: 'b', prompt_version: 'v',
    history: [], dispatcher_text: 'hi', system_prompt: 'S', reply: 'yo', error: null, regenerated_because: null,
    fell_back: false, provider_requests: 2, findings: [], attempts: SAMPLE_ATTEMPTS })
  assert.deepEqual(live.attempts, SAMPLE_ATTEMPTS)
  assert.deepEqual(live.usage, { prompt: 10, completion: 5, reasoning: 1, cached: 0, total: 15 })
  const old = liveRow({ id: 10, chat: 'broker', created_at: '2026-10-01T10:00:00Z', model: 'b', prompt_version: 'v',
    history: [], dispatcher_text: 'hi', system_prompt: 'S', reply: 'yo', error: null, regenerated_because: null,
    fell_back: false, provider_requests: 1, findings: [] })
  assert.deepEqual(old.attempts, [])
  assert.equal(old.usage, null)
})

// Kills: summing only the first attempt (a fallback's tokens lost) or
// treating missing reasoning as a number.
test('sumUsage adds every attempt that reported tokens', () => {
  assert.equal(sumUsage([]), null)
  assert.equal(sumUsage([{ usage: null }]), null)
  assert.equal(sumUsage(undefined), null)
  const two = [{ usage: { prompt: 100, completion: 20, reasoning: null, cached: null, total: 120 } }, ...SAMPLE_ATTEMPTS]
  assert.deepEqual(sumUsage(two), { prompt: 110, completion: 25, reasoning: 1, cached: 0, total: 135 })
})

// Kills: all-null parts summed to 0 ("reasoning 0" for a model that never
// reported reasoning), and prompt / completion invented when only total came.
test('sumUsage keeps a part null when no attempt reported it', () => {
  assert.deepEqual(
    sumUsage([{ usage: { prompt: null, completion: null, reasoning: null, cached: null, total: 900 } }]),
    { prompt: null, completion: null, reasoning: null, cached: null, total: 900 },
  )
  assert.deepEqual(
    sumUsage([{ usage: { total: 40 } }, { usage: { prompt: 10, completion: 5, reasoning: 0, total: 15 } }]),
    { prompt: 10, completion: 5, reasoning: 0, cached: null, total: 55 },
  )
})

// The training record (056): every live chat turn kept with the prompt it
// was answered from, and one export joining live turns, evaluation runs
// and grades. Azizbek, 2026-10-09: "if I test by hand, do the logs land?
// we need them for training." Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { turnRow, INSERT_TURN_SQL } from '../src/modules/chat/turnLog.js'
import { liveRow, withGrades, summary, readJsonl } from '../scripts/trainingRows.js'
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

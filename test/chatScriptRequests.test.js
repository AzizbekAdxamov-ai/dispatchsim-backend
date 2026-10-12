// 058: the evaluation and scenario scripts spend the same provider key as
// the app, and until now nothing counted it: on 2026-10-12 the budget read
// 0/45 after 40+ requests. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DAILY_USAGE_SQL } from '../src/modules/chat/chatBudget.sql.js'
import { chatTextRecorded } from '../src/modules/chat/scriptRequests.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8')

// A chatText stand-in that sends `n` "requests" (onRequest per attempt),
// optionally answering with another model, optionally throwing at the end.
const fakeChatText = ({ n, model = null, fail = false }) => async ({ onRequest, onModel }) => {
  for (let i = 0; i < n; i++) onRequest?.()
  if (model) onModel?.(model)
  if (fail) throw new Error('429')
  return 'ok'
}

// Kills: recording one per call instead of per request (a second try,
// backoff retry or fallback request would be lost), or dropping the model
// that actually answered.
test('every request of a call is recorded, fallback included', async () => {
  const rows = []
  const config = { model: 'main' }
  const reply = await chatTextRecorded({
    chatText: fakeChatText({ n: 3, model: 'fallback' }), source: 'eval', side: 'broker', config,
    record: async (r) => rows.push(r),
  })
  assert.equal(reply, 'ok')
  assert.deepEqual(rows, [{ source: 'eval', side: 'broker', model: 'fallback', requests: 3 }])
})

// Kills: recording only on success -- a refused call still spent requests.
test('a failed call is recorded and the error still reaches the script', async () => {
  const rows = []
  await assert.rejects(chatTextRecorded({
    chatText: fakeChatText({ n: 2, fail: true }), source: 'scenarios', side: 'driver',
    config: { model: 'main' }, record: async (r) => rows.push(r),
  }), /429/)
  assert.deepEqual(rows, [{ source: 'scenarios', side: 'driver', model: 'main', requests: 2 }])
})

// Kills: the script's own onRequest tally being replaced by the recorder's.
test('the caller still gets its own onRequest tally', async () => {
  let tally = 0
  await chatTextRecorded({
    chatText: fakeChatText({ n: 2 }), source: 'eval', side: 'broker', config: { model: 'm' },
    record: async () => {}, onRequest: () => { tally += 1 },
  })
  assert.equal(tally, 2)
})

// Kills: a failing write stopping the run or being swallowed silently.
test('a failed write warns without error text and does not stop the run', async () => {
  const errors = []
  const orig = console.error
  console.error = (m) => errors.push(m)
  try {
    const reply = await chatTextRecorded({
      chatText: fakeChatText({ n: 2 }), source: 'eval', side: 'broker', config: { model: 'm' },
      record: async () => { throw new Error('secret query data') },
    })
    assert.equal(reply, 'ok')
  } finally { console.error = orig }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /2 provider request/)
  assert.doesNotMatch(errors[0], /secret/)
})

// Kills: DAILY_USAGE_SQL not adding script rows, or counting them toward
// one dispatcher's share / a seat, or ignoring the wallet scope.
test('the daily usage adds script rows to the wallet total only, by scope', () => {
  assert.match(DAILY_USAGE_SQL, /FROM chat_script_requests s/)
  assert.match(DAILY_USAGE_SQL, /SELECT NULL::uuid, s\.requests, true/)
  assert.match(DAILY_USAGE_SQL, /\$2::text IN \('both', s\.side\)/)
  assert.match(DAILY_USAGE_SQL, /script_used/)
})

// Kills: either script going back to calling chatText directly.
for (const [file, source] of [['chat-eval.js', 'eval'], ['chat-scenarios.js', 'scenarios']]) {
  test(`${file} sends every request through the recorder`, () => {
    const src = read('scripts', file)
    assert.equal((src.match(/await chatText\(/g) ?? []).length, 0)
    assert.equal((src.match(/await chatTextRecorded\(/g) ?? []).length, 1)
    assert.match(src, new RegExp(`source: '${source}'`))
    const asks = (src.match(/await ask\(/g) ?? []).length
    assert.equal((src.match(/\), '(broker|driver)'\)/g) ?? []).length, asks)
  })
}

// Kills: a migration that allows other sources/sides or negative counts.
test('058 constrains source, side and count', () => {
  const sql = read('src', 'db', 'migrations', '058_chat_script_requests.sql')
  assert.match(sql, /source IN \('eval', 'scenarios'\)/)
  assert.match(sql, /side IN \('broker', 'driver'\)/)
  assert.match(sql, /requests >= 0/)
})

// --- against the database -------------------------------------------------

const { hasDb } = await import('./helpers/db.js')

// Kills: the SQL not actually summing script rows into account_used.
test('script rows raise account_used by their requests and nobody\'s share', { skip: !hasDb }, async () => {
  const { query, pool } = await import('../src/db/pool.js')
  const who = '00000000-0000-0000-0000-000000000000'
  const before = (await query(DAILY_USAGE_SQL, [who, 'both'])).rows[0]
  const brokerBefore = (await query(DAILY_USAGE_SQL, [who, 'broker'])).rows[0]
  const marker = 'test-058-marker'
  try {
    await query(`INSERT INTO chat_script_requests (source, side, model, requests) VALUES
      ('eval', 'broker', $1, 4), ('scenarios', 'driver', $1, 3)`, [marker])
    const both = (await query(DAILY_USAGE_SQL, [who, 'both'])).rows[0]
    const broker = (await query(DAILY_USAGE_SQL, [who, 'broker'])).rows[0]
    assert.equal(both.account_used - before.account_used, 7)
    assert.equal(both.script_used - before.script_used, 7)
    assert.equal(both.used, before.used)
    assert.equal(both.seats, before.seats)
    assert.equal(broker.script_used - brokerBefore.script_used, 4)
  } finally {
    await query('DELETE FROM chat_script_requests WHERE model = $1', [marker])
    await pool.end()
  }
})

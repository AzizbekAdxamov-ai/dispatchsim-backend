// A database without migration 060 (no `attempts` column): the two writers
// must keep the row instead of losing it. Fake database, no network.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import { insertScriptRequest, INSERT_SCRIPT_REQUESTS_SQL, INSERT_SCRIPT_REQUESTS_NO_ATTEMPTS_SQL } from '../src/modules/chat/scriptRequests.js'
import { logTurn, turnRow, INSERT_TURN_SQL, INSERT_TURN_NO_ATTEMPTS_SQL } from '../src/modules/chat/turnLog.js'
import { resetWarnings, warnOnce } from '../src/modules/chat/legacySchema.js'

const missingColumn = () => Object.assign(new Error('column "attempts" of relation does not exist'), { code: '42703' })

// A database that throws `err` on the first call and answers after.
function fakeDb(err) {
  const calls = []
  let first = true
  const run = async (sql, params) => {
    calls.push({ sql, params })
    if (first && err) { first = false; throw err }
  }
  return { run, calls }
}

const quiet = []
const realWarn = console.warn
// Each test captures the warning; the real console.warn is put back at the end.
after(() => { console.warn = realWarn })
beforeEach(() => {
  resetWarnings()
  quiet.length = 0
  console.warn = (m) => quiet.push(m)
})

const REQUEST = { source: 'eval', side: 'broker', model: 'm', requests: 2, attempts: [{ n: 1 }] }

// Kills: the script-request row lost on a database without 060 (the daily
// budget would silently undercount), or retried with the attempts anyway
test('a script request is written again without attempts on 42703', async () => {
  const db = fakeDb(missingColumn())
  await insertScriptRequest(REQUEST, db.run)
  assert.equal(db.calls.length, 2)
  assert.equal(db.calls[0].sql, INSERT_SCRIPT_REQUESTS_SQL)
  assert.equal(db.calls[1].sql, INSERT_SCRIPT_REQUESTS_NO_ATTEMPTS_SQL)
  assert.deepEqual(db.calls[1].params, ['eval', 'broker', 'm', 2])
  assert.equal(quiet.length, 1)
  assert.match(quiet[0], /migration 060 not applied/)
})

// Kills: a retry on a database that has the column (a double insert), or a
// different error swallowed by the fallback
test('a script request writes once when the column exists, and other errors are thrown', async () => {
  const ok = fakeDb(null)
  await insertScriptRequest(REQUEST, ok.run)
  assert.equal(ok.calls.length, 1)
  assert.deepEqual(ok.calls[0].params, ['eval', 'broker', 'm', 2, JSON.stringify([{ n: 1 }])])
  assert.equal(quiet.length, 0)

  const down = fakeDb(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
  await assert.rejects(insertScriptRequest(REQUEST, down.run), /connection refused/)
  assert.equal(down.calls.length, 1)
})

const TURN = { chat: 'broker', conversationId: 'c-1', model: 'm', promptVersion: 'v', systemPrompt: 'S', text: 'hi', reply: 'yo', attempts: [{ n: 1 }] }

// Kills: the turn-log row lost on a database without 060, or the retry
// sending 17 values to a 16-column insert
test('a turn is written again without attempts on 42703', async () => {
  const row = turnRow(TURN)
  const db = fakeDb(missingColumn())
  await logTurn(row, db.run)
  assert.equal(db.calls.length, 2)
  assert.equal(db.calls[0].sql, INSERT_TURN_SQL)
  assert.equal(db.calls[1].sql, INSERT_TURN_NO_ATTEMPTS_SQL)
  assert.equal(db.calls[0].params.length, 17)
  assert.equal(db.calls[1].params.length, 16)
  assert.equal((INSERT_TURN_NO_ATTEMPTS_SQL.match(/\$\d+/g) ?? []).length, 16)
  assert.deepEqual(db.calls[1].params, row.slice(0, 16))
  assert.match(quiet[0], /chat_turn_log has no attempts column/)
})

// Kills: a warning on every row (a log flood), or none at all
test('the missing-column warning is logged once per kind, not per row', async () => {
  const a = fakeDb(missingColumn())
  await logTurn(turnRow(TURN), a.run)
  const b = fakeDb(missingColumn())
  await logTurn(turnRow(TURN), b.run)
  assert.equal(quiet.length, 1)
  const c = fakeDb(missingColumn())
  await insertScriptRequest(REQUEST, c.run)
  assert.equal(quiet.length, 2, 'a different table warns once of its own')
  const seen = []
  warnOnce('k', 'x', (m) => seen.push(m)); warnOnce('k', 'x', (m) => seen.push(m))
  assert.deepEqual(seen, ['x'])
})

// Kills: a turn on a database with the column losing its attempts
test('a turn on a database with the column is written once, with attempts', async () => {
  const db = fakeDb(null)
  await logTurn(turnRow(TURN), db.run)
  assert.equal(db.calls.length, 1)
  assert.equal(db.calls[0].params[16], JSON.stringify([{ n: 1 }]))
})

// Kills: any database error treated as "no column" (a real failure hidden by a second insert)
test('a turn-log error that is not a missing column is thrown, with no second insert', async () => {
  const db = fakeDb(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
  await assert.rejects(logTurn(turnRow(TURN), db.run), /connection refused/)
  assert.equal(db.calls.length, 1)
  assert.equal(quiet.length, 0)
})

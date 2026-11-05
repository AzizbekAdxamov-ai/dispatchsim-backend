import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abortReason } from '../scripts/evalAttempts.js'

// Kills: a script bug reported as a bare "Chat evaluation aborted" with no reason (2026-11-04)
test('abortReason names a script bug, hides database detail, trusts cleaned messages', () => {
  assert.equal(abortReason(new ReferenceError('saysBooked is not defined')), 'ReferenceError: saysBooked is not defined')
  assert.equal(abortReason(Object.assign(new Error('relation "x" does not exist: SELECT secret'), { code: '42P01' })), 'database error 42P01')
  assert.equal(abortReason(Object.assign(new Error('Provider request failed'), { safeForConsole: true })), 'Provider request failed')
})

// Kills: a pg error without a SQLSTATE code printed with its message
test('abortReason recognises a database error by severity alone', () => {
  assert.equal(abortReason(Object.assign(new Error('secret detail'), { severity: 'ERROR' })), 'database error ERROR')
})

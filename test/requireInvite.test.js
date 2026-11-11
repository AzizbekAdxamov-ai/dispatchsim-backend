// REQUIRE_INVITE=on closes open registration: no invite code, no account.
// The gate runs before any database work.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import app from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { register } from '../src/modules/auth/auth.service.js'
import { ERROR_CODES } from '../src/lib/errors.js'
import { registerLimiter, globalLimiter } from '../src/middleware/rateLimit.js'

const REACHED_DB = 'reached the database'
const realConnect = pool.connect.bind(pool)
const original = config.requireInvite
let connects = 0

pool.connect = async () => { connects += 1; throw new Error(REACHED_DB) }
afterEach(() => { config.requireInvite = original; connects = 0 })

const person = { name: 'A B', company: 'C', email: 'a@b.test', password: 'long-enough-pw' }

test('config reads REQUIRE_INVITE: on => true, blank/off => false', async () => {
  const saved = process.env.REQUIRE_INVITE
  try {
    process.env.REQUIRE_INVITE = 'on'
    // Kills: ignoring the variable, or inverting it.
    assert.equal((await import('../src/config.js?on')).default.requireInvite, true)
    process.env.REQUIRE_INVITE = ''
    assert.equal((await import('../src/config.js?blank')).default.requireInvite, false)
    process.env.REQUIRE_INVITE = 'off'
    assert.equal((await import('../src/config.js?off')).default.requireInvite, false)
  } finally {
    if (saved === undefined) delete process.env.REQUIRE_INVITE; else process.env.REQUIRE_INVITE = saved
  }
})

test('on: register without an invite is INVITE_REQUIRED and touches no database', async () => {
  config.requireInvite = true
  // Kills: dropping the gate, or running it after the transaction opens.
  await assert.rejects(register(person), (err) => err.code === 'INVITE_REQUIRED')
  assert.equal(connects, 0)
  assert.equal(ERROR_CODES.INVITE_REQUIRED.status, 403)
  assert.equal(ERROR_CODES.INVITE_REQUIRED.message,
    'Registration requires an invite code. Ask your administrator for an invite link.')
})

test('on: over HTTP the answer is 403 INVITE_REQUIRED', async () => {
  config.requireInvite = true
  await registerLimiter.resetKey('127.0.0.1')
  await globalLimiter.resetKey('127.0.0.1')
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(person),
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'INVITE_REQUIRED')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('on: a request carrying an invite gets past the gate', async () => {
  config.requireInvite = true
  // Kills: gating on config alone without looking at input.invite.
  await assert.rejects(register({ ...person, invite: 'ABCD2345' }), /reached the database/)
  assert.equal(connects, 1)
})

test('off (default): register without an invite behaves as before', async () => {
  config.requireInvite = false
  // Kills: gating even when the switch is off.
  await assert.rejects(register(person), /reached the database/)
  assert.equal(connects, 1)
})

test('restore', () => { pool.connect = realConnect })

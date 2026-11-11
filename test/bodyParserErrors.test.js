// Malformed or oversized request bodies are the client's fault: 400 / 413,
// never 500 (and never a leaked parser message).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { ERROR_CODES } from '../src/lib/errors.js'
import { globalLimiter, authLimiter } from '../src/middleware/rateLimit.js'

async function post(body, contentType = 'application/json') {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    await globalLimiter.resetKey('127.0.0.1')
    await authLimiter.resetKey('127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/login`, {
      method: 'POST', headers: { 'content-type': contentType }, body,
    })
    return { status: res.status, body: await res.json() }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('invalid JSON is 400 INVALID_JSON', async () => {
  const { status, body } = await post('{"email": ')
  // Kills: removing the entity.parse.failed branch (falls to 500).
  assert.equal(status, 400)
  assert.equal(body.error.code, 'INVALID_JSON')
  assert.equal(body.error.message, 'Request body is not valid JSON')
  assert.equal(ERROR_CODES.INVALID_JSON.status, 400)
})

test('a body over 100kb is 413 PAYLOAD_TOO_LARGE', async () => {
  const { status, body } = await post(JSON.stringify({ email: 'a'.repeat(200 * 1024) }))
  // Kills: removing the entity.too.large branch (falls to 500).
  assert.equal(status, 413)
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE')
  assert.equal(body.error.message, 'Request body is too large')
})

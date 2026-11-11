// The ops secret: compared in constant time, closed when unset, rate limited.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import config from '../src/config.js'
import app from '../src/app.js'
import { requireOpsSecret } from '../src/middleware/opsSecret.js'
import { opsLimiter } from '../src/middleware/rateLimit.js'
import { OPS_LIMIT_PER_MINUTE } from '../src/constants/security.js'

const SECRET = 'correct-horse-battery-staple-ops'

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function runMiddleware(headers) {
  const req = { get: (name) => headers[name.toLowerCase()] }
  let outcome = 'pending'
  requireOpsSecret(req, {}, (err) => { outcome = err ? err.code : 'next' })
  return outcome
}

test('wrong, missing and length-different secrets are UNAUTHORIZED', () => {
  config.opsTickSecret = SECRET
  // Kills: a middleware that lets any request through.
  assert.equal(runMiddleware({}), 'UNAUTHORIZED')
  assert.equal(runMiddleware({ 'x-ops-secret': 'wrong-wrong-wrong-wrong-wrong-ops' }), 'UNAUTHORIZED')
  // Kills: timingSafeEqual called on raw buffers of unequal length (throws
  // RangeError -> 500) or a prefix comparison.
  assert.equal(runMiddleware({ 'x-ops-secret': 'short' }), 'UNAUTHORIZED')
  assert.equal(runMiddleware({ 'x-ops-secret': SECRET + 'x' }), 'UNAUTHORIZED')
  assert.equal(runMiddleware({ authorization: 'Bearer ' + SECRET.slice(0, -1) }), 'UNAUTHORIZED')
})

test('the right secret passes through either header shape', () => {
  config.opsTickSecret = SECRET
  // Kills: dropping the x-ops-secret branch.
  assert.equal(runMiddleware({ 'x-ops-secret': SECRET }), 'next')
  // Kills: dropping the Bearer branch (Vercel cron sends this one).
  assert.equal(runMiddleware({ authorization: `Bearer ${SECRET}` }), 'next')
})

test('an empty configured secret keeps the route closed', () => {
  config.opsTickSecret = ''
  // Kills: comparing against '' so an empty header opens the endpoint.
  assert.equal(runMiddleware({ 'x-ops-secret': '' }), 'TICK_NOT_CONFIGURED')
  assert.equal(runMiddleware({}), 'TICK_NOT_CONFIGURED')
})

test('real /ops routes reject a wrong secret on both handlers', async () => {
  config.opsTickSecret = SECRET
  await opsLimiter.resetKey('127.0.0.1')
  await withServer(async (base) => {
    for (const path of ['/ops/tick', '/ops/refresh']) {
      for (const method of ['GET', 'POST']) {
        // Kills: a handler that forgot to use the shared check.
        const res = await fetch(base + path, { method, headers: { 'x-ops-secret': 'nope' } })
        assert.equal(res.status, 401, `${method} ${path}`)
      }
    }
  })
})

test('opsLimiter allows exactly 30 requests per minute per IP', async () => {
  config.opsTickSecret = ''
  await opsLimiter.resetKey('127.0.0.1')
  await withServer(async (base) => {
    // Kills: changing the limit value or unmounting the limiter.
    assert.equal(OPS_LIMIT_PER_MINUTE, 30)
    for (let i = 0; i < OPS_LIMIT_PER_MINUTE; i++) {
      assert.equal((await fetch(`${base}/ops/tick`)).status, 503)
    }
    const blocked = await fetch(`${base}/ops/tick`)
    assert.equal(blocked.status, 429)
    assert.equal((await blocked.json()).error.code, 'RATE_LIMITED')
  })
})

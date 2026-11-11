// Flood protection: one global ceiling, a stricter one on PDF routes, and
// two paths (/health, /ops) that the global ceiling must never touch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import config from '../src/config.js'
import { globalLimiter, pdfLimiter, opsLimiter } from '../src/middleware/rateLimit.js'
import {
  GLOBAL_LIMIT_PER_MINUTE, PDF_LIMIT_PER_MINUTE, OPS_LIMIT_PER_MINUTE,
} from '../src/constants/security.js'

const IP = '127.0.0.1'

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

async function resetAll() {
  await globalLimiter.resetKey(IP)
  await pdfLimiter.resetKey(IP)
  await opsLimiter.resetKey(IP)
}

test('limits are the agreed numbers', () => {
  // Kills: editing a constant without noticing what it protects.
  assert.equal(GLOBAL_LIMIT_PER_MINUTE, 600)
  assert.equal(PDF_LIMIT_PER_MINUTE, 20)
  assert.ok(PDF_LIMIT_PER_MINUTE < GLOBAL_LIMIT_PER_MINUTE)
})

test('the 601st request in a minute gets 429 RATE_LIMITED; /health is exempt', async () => {
  await resetAll()
  await withServer(async (base) => {
    for (let i = 0; i < GLOBAL_LIMIT_PER_MINUTE; i++) {
      assert.equal((await fetch(`${base}/no-such-route`)).status, 404)
    }
    // Kills: unmounting the global limiter or raising its limit.
    const blocked = await fetch(`${base}/no-such-route`)
    assert.equal(blocked.status, 429)
    assert.equal((await blocked.json()).error.code, 'RATE_LIMITED')
    // Kills: removing the /health skip (load balancers would be throttled).
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/health`)).status, 200)
  })
})

test('/ops is skipped by the global limiter (it has its own)', async () => {
  await resetAll()
  config.opsTickSecret = ''
  await withServer(async (base) => {
    for (let i = 0; i < GLOBAL_LIMIT_PER_MINUTE; i++) await fetch(`${base}/no-such-route`)
    // Kills: removing the /ops skip -- the scheduler would get 429 from the
    // global bucket although it makes one call a day.
    assert.equal((await fetch(`${base}/ops/tick`)).status, 503)
  })
})

test('PDF routes hit their own limit long before the global one', async () => {
  await resetAll()
  await withServer(async (base) => {
    const paths = [
      '/documents/loads/1/bol.pdf',
      '/documents/loads/1/pod.pdf',
      '/documents/invoices/1/invoice.pdf',
      '/broker-chat/1/rate-confirmation.pdf',
    ]
    for (const path of paths) {
      await pdfLimiter.resetKey(IP)
      for (let i = 0; i < PDF_LIMIT_PER_MINUTE; i++) {
        // Unauthenticated: 401, but still counted, which is the point --
        // the limiter sits in front of auth so hammering is throttled.
        assert.equal((await fetch(base + path)).status, 401, path)
      }
      // Kills: pdfLimiter missing from that route.
      assert.equal((await fetch(base + path)).status, 429, path)
    }
    // Kills: pdfLimiter mounted on a whole router instead of the PDF routes.
    await pdfLimiter.resetKey(IP)
    assert.equal((await fetch(`${base}/broker-chat/1`)).status, 401)
  })
})

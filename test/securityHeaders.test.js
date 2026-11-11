// Response headers of a JSON API: no framing, no sniffing, no sub-resources.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('API responses carry hardening headers and hide Express', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`)
    // Kills: removing helmet from app.js.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    // Kills: dropping frame-ancestors / default-src from the CSP.
    const csp = res.headers.get('content-security-policy')
    assert.ok(csp.includes("frame-ancestors 'none'"), csp)
    assert.ok(csp.includes("default-src 'none'"), csp)
    // Kills: deleting app.disable('x-powered-by').
    assert.equal(res.headers.get('x-powered-by'), null)
    // Kills: helmet's default same-origin CORP, which would block the
    // frontend (another domain) from loading PDFs and JSON.
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin')
  })
})

// GET /fleet/truck-listings?limit= : bounded, validated, default 100.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { listOpenListings } from '../src/modules/fleet/truckListings.controller.js'
import { listingsQuerySchema } from '../src/modules/fleet/fleet.schemas.js'
import { errorHandler } from '../src/middleware/errorHandler.js'
import { MAX_PAGE } from '../src/constants/security.js'

test('limit defaults to MAX_PAGE and accepts 1..MAX_PAGE', () => {
  // Kills: losing the default (limit undefined -> unbounded query).
  assert.equal(listingsQuerySchema.parse({}).limit, MAX_PAGE)
  assert.equal(listingsQuerySchema.parse({ limit: '1' }).limit, 1)
  assert.equal(listingsQuerySchema.parse({ limit: String(MAX_PAGE) }).limit, MAX_PAGE)
})

test('out-of-range or non-integer limit answers 400 VALIDATION_ERROR before any query', async () => {
  const app = express()
  app.get('/l', listOpenListings)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    // Kills: removing .max(MAX_PAGE), .min(1) or .int(); and the old
    // `Number(x) || 100` which turned "0" and "abc" into 100.
    for (const bad of ['0', '-1', String(MAX_PAGE + 1), '1.5', 'abc', '1000000']) {
      const res = await fetch(`${base}/l?limit=${bad}`)
      assert.equal(res.status, 400, `limit=${bad}`)
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR')
    }
  } finally {
    await new Promise((r) => server.close(r))
  }
})

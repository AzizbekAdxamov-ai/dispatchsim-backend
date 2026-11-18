// /academy/mentor/* is gated by is_mentor / is_admin read fresh from the
// database. No real database: pool.query is faked and restored afterwards.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { sign } from '../src/lib/token.js'
import { globalLimiter } from '../src/middleware/rateLimit.js'

const USER_ID = 'u-academy'
const store = { flags: null }
const realQuery = pool.query.bind(pool)
let server
let base

before(async () => {
  pool.query = async (text, params) => {
    if (text.includes('is_mentor AS "isMentor"') && text.includes('"roleCount"')) {
      return { rows: params[0] === USER_ID && store.flags ? [store.flags] : [] }
    }
    return { rows: [] }
  }
  server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  pool.query = realQuery
  await new Promise((r) => server.close(r))
  await pool.end()
})

async function status(flags) {
  await globalLimiter.resetKey('127.0.0.1')
  store.flags = flags
  const res = await fetch(`${base}/academy/mentor/cohorts`, {
    headers: { authorization: `Bearer ${sign({ id: USER_ID })}` },
  })
  return res.status
}

test('an ordinary user gets 403 on mentor routes', async () => {
  assert.equal(await status({ isAdmin: false, isMentor: false, roleCount: 1 }), 403)
})

test('a mentor and an admin are let through', async () => {
  assert.notEqual(await status({ isAdmin: false, isMentor: true, roleCount: 0 }), 403)
  assert.notEqual(await status({ isAdmin: true, isMentor: false, roleCount: 0 }), 403)
})

test('revoking mentor access applies on the next request with the same token', async () => {
  assert.notEqual(await status({ isAdmin: false, isMentor: true, roleCount: 0 }), 403)
  assert.equal(await status({ isAdmin: false, isMentor: false, roleCount: 0 }), 403)
})

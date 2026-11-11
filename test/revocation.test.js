// A token stays cryptographically valid until it expires, but what it may
// DO is re-read from the database on every request. Pinned here so nobody
// "optimises" role checks into the JWT or a cache.
//
// No real database: pool.query is replaced by an in-memory fake that answers
// only the two lookups these middlewares make, and restored afterwards.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { pool } from '../src/db/pool.js'
import { sign } from '../src/lib/token.js'
import { globalLimiter } from '../src/middleware/rateLimit.js'

const USER_ID = 'u-revoked'
const store = { user: null, roles: [] }
const realQuery = pool.query.bind(pool)
let server
let base

before(async () => {
  pool.query = async (text, params) => {
    if (text.includes('FROM user_roles') && text.includes('WHERE user_id')) {
      return { rows: params[0] === USER_ID ? store.roles.map((role) => ({ role })) : [] }
    }
    if (text.includes('FROM users u') && text.includes('WHERE u.id')) {
      return { rows: params[0] === USER_ID && store.user ? [store.user] : [] }
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

const authed = (path, token) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } })

test('a revoked role is refused on the very next request with the same valid token', async () => {
  await globalLimiter.resetKey('127.0.0.1')
  const token = sign({ id: USER_ID })
  store.user = { id: USER_ID, roles: ['dispatcher'] }
  store.roles = ['dispatcher']
  // Control: while granted, the gate does not answer 403.
  assert.notEqual((await authed('/broker-chat', token)).status, 403)

  store.roles = []
  const res = await authed('/broker-chat', token)
  // Kills: moving the role check into the token or caching it per user.
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'FORBIDDEN')
})

test('a deleted user gets USER_NOT_FOUND from /auth/me with a still-valid token', async () => {
  await globalLimiter.resetKey('127.0.0.1')
  const token = sign({ id: USER_ID })
  store.user = { id: USER_ID, name: 'N', email: 'e@x.test', company: 'C', roles: [], activeRole: null, isAdmin: false }
  assert.equal((await authed('/auth/me', token)).status, 200)

  store.user = null
  const res = await authed('/auth/me', token)
  // Kills: answering /auth/me from the token payload instead of the database.
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'USER_NOT_FOUND')
})

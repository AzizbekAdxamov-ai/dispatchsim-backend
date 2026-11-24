// /academy is gated by cohort membership, is_mentor or is_admin; /academy/mentor/*
// by is_mentor or is_admin. All read fresh from the database.
// No real database: pool.query is faked and restored afterwards.

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
    // Unique to findAccessFlagsById (USER_COLUMNS also has "isCohortMember").
    if (text.includes('FROM users u WHERE u.id = $1') && text.includes('"isCohortMember"') && !text.includes('LATERAL')) {
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

async function call(flags, method, path, body) {
  await globalLimiter.resetKey('127.0.0.1')
  store.flags = flags
  const headers = { authorization: `Bearer ${sign({ id: USER_ID })}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method, headers, body })
  return res.status
}

const getMe = (flags) => call(flags, 'GET', '/academy/me')
const putProgress = (flags) => call(flags, 'PUT', '/academy/progress/1', '{"exitsDone":{}}')
const getCohorts = (flags) => call(flags, 'GET', '/academy/mentor/cohorts')

const plain = { isAdmin: false, isMentor: false, isCohortMember: false }
const cohort = { ...plain, isCohortMember: true }
const mentor = { ...plain, isMentor: true }
const admin = { ...plain, isAdmin: true }

test('a1: roles alone (roleCount ignored) do not open GET /academy/me', async () => {
  assert.equal(await getMe({ ...plain, roleCount: 3 }), 403)
})

test('a2: roles alone (roleCount ignored) do not open PUT /academy/progress', async () => {
  assert.equal(await putProgress({ ...plain, roleCount: 3 }), 403)
})

test('b: a cohort member reaches the student routes', async () => {
  assert.equal(await getMe(cohort), 200)
  assert.equal(await putProgress(cohort), 200)
})

test('c: a mentor reaches the student routes', async () => {
  assert.equal(await getMe(mentor), 200)
  assert.equal(await putProgress(mentor), 200)
})

test('d: an admin reaches the student routes', async () => {
  assert.equal(await getMe(admin), 200)
  assert.equal(await putProgress(admin), 200)
})

test('m1: an ordinary user gets 403 on mentor routes', async () => {
  assert.equal(await getCohorts(plain), 403)
})

test('m2: a cohort member gets 403 on mentor routes', async () => {
  assert.equal(await getCohorts(cohort), 403)
})

test('m3: a mentor and an admin are let through mentor routes', async () => {
  assert.equal(await getCohorts(mentor), 200)
  assert.equal(await getCohorts(admin), 200)
})

test('revoking mentor access applies on the next request with the same token', async () => {
  assert.equal(await getCohorts(mentor), 200)
  assert.equal(await getCohorts(plain), 403)
})

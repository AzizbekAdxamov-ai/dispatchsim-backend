import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { authLimiter } from '../src/middleware/rateLimit.js'
import { errorHandler } from '../src/middleware/errorHandler.js'
import { AppError } from '../src/lib/errors.js'

test('login counts client failures, not successful logins or server failures, and exposes safe cooldown', async () => {
  const app = express()
  app.post('/login', authLimiter, (req, res) => res.sendStatus(Number(req.query.status)))
  app.post('/hold', authLimiter, (_req, res) => res.write('pending'))
  app.get('/safe', (_req, _res, next) => next(new AppError('RATE_LIMITED', { retryAfterSeconds: 30, password: 'private' })))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = status => fetch(`${base}/login?status=${status}`, { method: 'POST' })
  try {
    for (const status of [200, 500, 503]) {
      for (let i = 0; i < 12; i++) assert.equal((await request(status)).status, status)
    }
    for (let i = 0; i < 10; i++) assert.equal((await request(i % 2 ? 400 : 401)).status, i % 2 ? 400 : 401)
    const blocked = await request(200)
    assert.equal(blocked.status, 429)
    const body = await blocked.json()
    assert.equal(body.error.code, 'RATE_LIMITED')
    assert.ok(body.error.details.retryAfterSeconds > 0 && body.error.details.retryAfterSeconds <= 900)
    assert.equal(Number(blocked.headers.get('Retry-After')), body.error.details.retryAfterSeconds)
    assert.deepEqual((await (await fetch(`${base}/safe`)).json()).error.details, { retryAfterSeconds: 30 })
    await authLimiter.resetKey('127.0.0.1')
    assert.equal((await request(200)).status, 200)
    // Unfinished requests reserve all ten slots; disconnects release them.
    const controllers = Array.from({ length: 10 }, () => new AbortController())
    await Promise.all(controllers.map(c => fetch(`${base}/hold`, { method: 'POST', signal: c.signal })))
    assert.equal((await request(200)).status, 429)
    controllers.forEach(c => c.abort())
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await request(200)).status, 200)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

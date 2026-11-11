// What reaches the server log when something unexpected throws. A pg error
// carries `detail` ("Key (email)=(a@b.c) already exists") and sometimes the
// bound parameters; none of that belongs in logs.

import { inspect } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorHandler } from '../src/middleware/errorHandler.js'
import { AppError } from '../src/lib/errors.js'

function capture(err) {
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args)
  const res = { status() { return this }, json() {} }
  try { errorHandler(err, {}, res, () => {}) } finally { console.error = original }
  // What console.error would print: util.inspect shows every own property.
  return logged.map((args) => args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 5 }))).join(' ')).join('\n')
}

test('a pg-style error never logs its detail, parameters or email', () => {
  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    name: 'error',
    code: '23505',
    constraint: 'some_other_key',
    detail: 'Key (email)=(victim@private.example) already exists.',
    parameters: ['victim@private.example'],
    where: 'secret-where',
  })
  const out = capture(pgErr)
  // Kills: going back to console.error(err), which prints every property.
  assert.ok(!out.includes('victim@private.example'), out)
  assert.ok(!out.includes('secret-where'), out)
  assert.ok(!out.includes('Key (email)'), out)
})

test('the sanitized log still says what failed', () => {
  const pgErr = Object.assign(new Error('boom'), { code: '23505', constraint: 'some_other_key', detail: 'x' })
  const out = capture(pgErr)
  // Kills: logging nothing at all (blind operations).
  for (const part of ['boom', '23505', 'some_other_key']) assert.ok(out.includes(part), `${part} missing: ${out}`)
})

test('an AppError is logged by code, not dumped', () => {
  const out = capture(new AppError('VALIDATION_ERROR', [{ path: 'email', message: 'victim@private.example' }]))
  // Kills: logging AppError.details (they can echo user input).
  assert.ok(!out.includes('victim@private.example'), out)
})

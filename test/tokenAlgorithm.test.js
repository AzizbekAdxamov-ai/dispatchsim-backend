// JWT algorithm pinning: only HS256 is signed and accepted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import config from '../src/config.js'
import { sign, verify } from '../src/lib/token.js'

test('sign() issues HS256 and verify() accepts it', () => {
  const token = sign({ id: 'user-1' })
  // Kills: dropping `algorithm: 'HS256'` from sign (header would still be
  // HS256 by default, so this pins the contract) or breaking verify.
  assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS256')
  assert.equal(verify(token).sub, 'user-1')
})

test('a token signed with the same secret but HS512 is rejected', () => {
  const forged = jwt.sign({ sub: 'user-1' }, config.jwtSecret, { algorithm: 'HS512' })
  // Kills: removing `algorithms: ['HS256']` from verify.
  assert.throws(() => verify(forged), (err) => err.code === 'UNAUTHORIZED')
})

test('an unsigned (alg none) token is rejected', () => {
  const none = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' })
  // Kills: an allow-list that includes 'none'.
  assert.throws(() => verify(none), (err) => err.code === 'UNAUTHORIZED')
})

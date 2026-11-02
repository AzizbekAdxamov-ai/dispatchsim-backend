// `chat:eval --arm X`: parsing the flag and copying the arm's settings.
// Pure; the script itself calls the model and is not run here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArm, applyArm } from '../scripts/evalArm.js'

// Kills: --arm without a value silently running the production config.
test('parseArm needs a value and uppercases it', () => {
  assert.deepEqual(parseArm(['broker']), { arm: null })
  assert.ok(parseArm(['--arm']).error)
  assert.ok(parseArm(['--arm', '--gap', '5']).error)
  assert.deepEqual(parseArm(['--arm', 'b']), { arm: 'B' })
  assert.deepEqual(parseArm(['--arm=b2']), { arm: 'B2' })
})

// Kills: an arm inheriting another arm's pin, or a key value printed.
test('applyArm copies to both chats, clears the pin, and names only missing variables', () => {
  const env = {
    CHAT_AB_B_BASE_URL: 'https://openrouter.ai/api/v1',
    CHAT_AB_B_API_KEY: 'sk-secret-value-123',
    CHAT_AB_B_MODEL: 'm/b',
    CHAT_BROKER_PROVIDER_ORDER: 'old',
    CHAT_DRIVER_PROVIDER_ORDER: 'old',
  }
  assert.deepEqual(applyArm(env, 'B'), { errors: [] })
  for (const side of ['BROKER', 'DRIVER']) {
    assert.equal(env[`CHAT_${side}_BASE_URL`], 'https://openrouter.ai/api/v1')
    assert.equal(env[`CHAT_${side}_API_KEY`], 'sk-secret-value-123')
    assert.equal(env[`CHAT_${side}_MODEL`], 'm/b')
    assert.equal(env[`CHAT_${side}_PROVIDER_ORDER`], '')
  }
  env.CHAT_AB_B_PROVIDER_ORDER = 'deepinfra'
  applyArm(env, 'B')
  assert.equal(env.CHAT_DRIVER_PROVIDER_ORDER, 'deepinfra')

  const partial = { CHAT_AB_C_API_KEY: 'sk-secret-value-123' }
  const { errors } = applyArm(partial, 'C')
  assert.deepEqual(errors, ['CHAT_AB_C_BASE_URL', 'CHAT_AB_C_MODEL'])
  assert.equal(JSON.stringify(errors).includes('sk-secret'), false)
})

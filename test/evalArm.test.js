// `chat:eval --arm X`: parsing the flag and copying the arm's settings.
// Pure; the script itself calls the model and is not run here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArm, applyArm, armConfig, reasoningEffortOf, armRecordFields } from '../scripts/evalArm.js'

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x'
process.env.JWT_SECRET ??= 'x'.repeat(48)
const { chatConfigFor } = await import('../src/modules/chat/chatProvider.js')
const OR = 'https://openrouter.ai/api/v1'
const GROQ = 'https://api.groq.com/openai/v1'

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

// Kills: an arm inheriting the shared production pin (CHAT_PROVIDER_ORDER)
// because a blank own var falls through to it.
test('after applyArm the resolved provider order is the arm pin, never the shared production one', () => {
  const names = ['CHAT_PROVIDER_ORDER', 'CHAT_BROKER_PROVIDER_ORDER', 'CHAT_DRIVER_PROVIDER_ORDER', 'CHAT_BROKER_BASE_URL', 'CHAT_BROKER_API_KEY', 'CHAT_BROKER_MODEL', 'CHAT_DRIVER_BASE_URL', 'CHAT_DRIVER_API_KEY', 'CHAT_DRIVER_MODEL']
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]))
  try {
    for (const pin of [undefined, 'deepinfra']) {
      for (const n of names) delete process.env[n]
      process.env.CHAT_PROVIDER_ORDER = 'prod'
      process.env.CHAT_AB_Z_BASE_URL = OR
      process.env.CHAT_AB_Z_API_KEY = 'test-key'
      process.env.CHAT_AB_Z_MODEL = 'm/z'
      if (pin) process.env.CHAT_AB_Z_PROVIDER_ORDER = pin
      else delete process.env.CHAT_AB_Z_PROVIDER_ORDER
      assert.deepEqual(applyArm(process.env, 'Z'), { errors: [] })
      for (const side of ['broker', 'driver']) {
        assert.deepEqual(chatConfigFor(side).providerOrder, pin ? [pin] : null)
      }
    }
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
    for (const n of ['CHAT_AB_Z_BASE_URL', 'CHAT_AB_Z_API_KEY', 'CHAT_AB_Z_MODEL', 'CHAT_AB_Z_PROVIDER_ORDER']) delete process.env[n]
  }
})

// Kills: the fallback model answering during an arm run, or the arm fields
// and reasoning effort being wrong for a family.
test('chat-eval wiring helpers: fallback dropped, effort per family, arm fields on every record', () => {
  const base = { baseUrl: OR, model: 'm', fallbackModel: 'f', providerOrder: ['x'], chat: 'broker' }
  // The developer's own env must not decide these answers.
  const envNames = ['CHAT_REASONING', 'CHAT_GROQ_REASONING_EFFORT', 'CHAT_BROKER_REASONING_EFFORT']
  const savedEnv = Object.fromEntries(envNames.map((n) => [n, process.env[n]]))
  for (const n of envNames) delete process.env[n]
  try {
  assert.equal('fallbackModel' in armConfig(base, 'B'), false)
  assert.equal(armConfig(base, null).fallbackModel, 'f')
  assert.equal(reasoningEffortOf({ ...base, model: 'deepseek/deepseek-v4.1-flash' }), 'high')
  assert.equal(reasoningEffortOf({ ...base, model: 'openai/gpt-oss-120b' }), 'low')
  assert.equal(reasoningEffortOf({ ...base, baseUrl: GROQ, model: 'openai/gpt-oss-120b' }), 'low')
  assert.equal(reasoningEffortOf({ ...base, baseUrl: GROQ, model: 'llama' }), 'n/a')
  assert.deepEqual(armRecordFields(base, 'B'), { arm: 'B', provider: 'openrouter', providerOrder: ['x'] })
  } finally {
    for (const n of envNames) { if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n] }
  }
  // Source check (chat-eval.js needs a database to run): both records use it.
  const src = readFileSync(new URL('../scripts/chat-eval.js', import.meta.url), 'utf8')
  assert.equal((src.match(/\.\.\.armRecordFields\(config, arm\)/g) ?? []).length, 2)
})

// One key or two?
//
// The broker chat and the driver chat can now run on separate keys. That
// changes the budget: two chats on one key share one daily allowance, two
// chats on two keys have one each. Getting this backwards is not a visible
// bug -- it is a key quietly spent twice, discovered as a 429 on a day
// nobody was watching.
//
// Nothing here touches the network or the database. It sets environment
// variables and asks what the code concluded, because that is the whole
// of the decision.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// config.js refuses to load without these two; the tests below never use
// them. Set before the dynamic imports so the file is hermetic.
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x'
process.env.JWT_SECRET ??= 'x'.repeat(48)
const { default: appConfig } = await import('../src/config.js')
const { chatConfigFor, walletScopeFor, describeChat } = await import('../src/modules/chat/chatProvider.js')
const FALLBACK = 'backup/model:free'

const VARS = [
  'CHAT_BASE_URL', 'CHAT_API_KEY', 'CHAT_MODEL',
  'CHAT_BROKER_BASE_URL', 'CHAT_BROKER_API_KEY', 'CHAT_BROKER_MODEL',
  'CHAT_DRIVER_BASE_URL', 'CHAT_DRIVER_API_KEY', 'CHAT_DRIVER_MODEL',
]

// dotenv has already loaded the developer's real .env by the time this
// file runs. Clearing every variable first is what keeps these tests from
// passing or failing according to whose machine they run on.
beforeEach(() => {
  for (const v of VARS) delete process.env[v]
  appConfig.chatDriverFallbackModel = null
  appConfig.chatBrokerFallbackModel = null
})

test('one shared key means one shared wallet', () => {
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'

  assert.equal(walletScopeFor('broker'), 'both')
  assert.equal(walletScopeFor('driver'), 'both')
})

test('a second key gives the driver its own wallet', () => {
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_DRIVER_API_KEY = 'key-two'

  assert.equal(walletScopeFor('broker'), 'broker')
  assert.equal(walletScopeFor('driver'), 'driver')
})

test('the same key written twice is still one wallet', () => {
  // The trap: deciding by whether CHAT_DRIVER_API_KEY is SET rather than
  // by what it holds. Someone copying the key into both variables would
  // be given two budgets for one key, and the provider would enforce one.
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_DRIVER_API_KEY = 'key-one'

  assert.equal(walletScopeFor('broker'), 'both')
  assert.equal(walletScopeFor('driver'), 'both')
})

test('the same key at two providers is two wallets', () => {
  // Rate limits are per provider. One string used at two companies is two
  // allowances, however identical it looks.
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_DRIVER_BASE_URL = 'https://api.groq.com/openai/v1'

  assert.equal(walletScopeFor('broker'), 'broker')
  assert.equal(walletScopeFor('driver'), 'driver')
})

test('a different model on one key is still one wallet', () => {
  // The budget belongs to the key. Two models on one key spend the same
  // requests, so splitting the budget by model would over-spend it.
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_BROKER_MODEL = 'another/model'

  assert.equal(walletScopeFor('broker'), 'both')
  assert.equal(chatConfigFor('broker').model, 'another/model')
  assert.equal(chatConfigFor('driver').model, 'some/model')
})

// Kills: one chat reading the other's fallback variable (the broker given
// Grace's model or the reverse), so each chat switches to a model chosen
// for the other.
test('each chat reads its own fallback model', () => {
  appConfig.chatDriverFallbackModel = 'driver/backup'
  appConfig.chatBrokerFallbackModel = 'broker/backup'
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  assert.equal(chatConfigFor('driver').fallbackModel, 'driver/backup')
  assert.equal(chatConfigFor('broker').fallbackModel, 'broker/backup')
  assert.equal(describeChat('broker').fallbackModel, 'broker/backup')

  appConfig.chatDriverFallbackModel = null
  assert.equal(chatConfigFor('driver').fallbackModel, undefined)
  assert.equal(chatConfigFor('broker').fallbackModel, 'broker/backup')
})

// Kills: keeping the old OpenRouter-only gate, which silently dropped the
// fallback on Groq and left a busy primary with no second model.
test('the fallback is kept on Groq', () => {
  appConfig.chatDriverFallbackModel = 'openai/gpt-oss-20b'
  appConfig.chatBrokerFallbackModel = 'openai/gpt-oss-20b'
  process.env.CHAT_BASE_URL = 'https://api.groq.com/openai/v1'
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'qwen/qwen3-32b'
  assert.equal(chatConfigFor('driver').fallbackModel, 'openai/gpt-oss-20b')
  assert.equal(chatConfigFor('broker').fallbackModel, 'openai/gpt-oss-20b')
})

// Kills: offering a fallback equal to the model already in use, which would
// repeat the same throttled request and spend a budgeted call on it.
test('a fallback equal to the primary means no fallback, for both chats', () => {
  appConfig.chatDriverFallbackModel = FALLBACK
  appConfig.chatBrokerFallbackModel = FALLBACK
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = FALLBACK
  assert.equal(chatConfigFor('driver').fallbackModel, undefined)
  assert.equal(chatConfigFor('broker').fallbackModel, undefined)
  assert.equal(describeChat('broker').fallbackModel, null)
})

// Kills: a hardcoded broker fallback that applies when
// CHAT_BROKER_FALLBACK_MODEL is blank, so the broker silently doubles
// requests nobody asked for.
test('with the broker fallback blank, broker chatText never tries another model', async () => {
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  const broker = chatConfigFor('broker')
  assert.equal(broker.fallbackModel, undefined)

  const { chatText } = await import('../scripts/seed/aiClient.js')
  const real = globalThis.fetch
  const models = []
  globalThis.fetch = async (_url, opts) => {
    models.push(JSON.parse(opts.body).model)
    return { ok: false, status: 429, headers: { get: (h) => (/retry-after/i.test(h) ? '0' : null) }, text: async () => JSON.stringify({ error: { message: 'upstream model is busy' } }) }
  }
  try {
    await assert.rejects(chatText({ messages: [], config: broker }), (err) => err.rateLimited === true)
  } finally {
    globalThis.fetch = real
  }
  assert.ok(models.length >= 1)
  assert.deepEqual([...new Set(models)], ['some/model'])
})

// Kills: a hardcoded fallback model that applies when CHAT_DRIVER_FALLBACK_MODEL
// is blank, so Grace silently doubles requests nobody asked for.
test('with no fallback configured the driver config has none and chatText never tries another model', async () => {
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  const driver = chatConfigFor('driver')
  assert.equal(driver.fallbackModel, undefined)

  const { chatText } = await import('../scripts/seed/aiClient.js')
  const real = globalThis.fetch
  const models = []
  globalThis.fetch = async (_url, opts) => {
    models.push(JSON.parse(opts.body).model)
    return { ok: false, status: 429, headers: { get: (h) => (/retry-after/i.test(h) ? '0' : null) }, text: async () => JSON.stringify({ error: { message: 'upstream model is busy' } }) }
  }
  try {
    await assert.rejects(chatText({ messages: [], config: driver }), (err) => err.rateLimited === true)
  } finally {
    globalThis.fetch = real
  }
  // The primary's own retries may send several; none may go to another model.
  assert.ok(models.length >= 1)
  assert.deepEqual([...new Set(models)], ['some/model'])
})

test('each chat inherits what its own family does not set', () => {
  process.env.CHAT_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_DRIVER_API_KEY = 'key-two'

  const driver = chatConfigFor('driver')
  assert.equal(driver.apiKey, 'key-two', 'o\'z kalitini olmadi')
  assert.equal(driver.model, 'some/model', 'modelni meros qilib olmadi')
  assert.equal(driver.baseUrl, 'https://openrouter.ai/api/v1', 'base URL merosi ishlamadi')
})

test('a variable emptied out falls through instead of blanking the value', () => {
  // Commenting a value out by deleting the text after '=' is the most
  // natural way to disable it. If that produced a blank base URL rather
  // than falling through to CHAT_BASE_URL, the chat would call nowhere.
  process.env.CHAT_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.CHAT_API_KEY = 'key-one'
  process.env.CHAT_MODEL = 'some/model'
  process.env.CHAT_DRIVER_BASE_URL = '   '

  assert.equal(chatConfigFor('driver').baseUrl, 'https://openrouter.ai/api/v1')
})

test('a missing model is refused by name, not defaulted into a 404', () => {
  process.env.CHAT_API_KEY = 'key-one'
  // CHAT_MODEL deliberately unset.
  assert.throws(() => chatConfigFor('broker'), (err) => {
    assert.equal(err.code, 'CHAT_UNAVAILABLE')
    const said = String(err.details)
    // Both names. The specific one is where an override goes; the shared
    // one is where most people will actually set it, and an error naming
    // only CHAT_BROKER_MODEL sends someone hunting for a variable their
    // .env does not have and was never meant to.
    assert.match(said, /CHAT_BROKER_MODEL/, 'aniq o\'zgaruvchi nomi yo\'q')
    assert.match(said, /CHAT_MODEL/, 'umumiy o\'zgaruvchi nomi yo\'q')
    // And where to go next, because the person reading this does not know
    // which model to write.
    assert.match(said, /chat:diag/, 'keyingi qadam aytilmagan')
    return true
  })
})

test('each chat fails with a sentence about the right person', () => {
  process.env.CHAT_MODEL = 'some/model'
  // No key at all.
  assert.throws(() => chatConfigFor('broker'), (e) => e.code === 'CHAT_UNAVAILABLE')
  assert.throws(() => chatConfigFor('driver'), (e) => e.code === 'DRIVER_UNREACHABLE')
})

test('an unconfigured counterpart does not put the working chat in a shared wallet', () => {
  // The broker chat is configured; the driver chat has no key at all.
  // Telling the broker it shares a budget with a chat that cannot make a
  // single call would divide its allowance for no reason.
  process.env.CHAT_BROKER_API_KEY = 'key-one'
  process.env.CHAT_BROKER_MODEL = 'some/model'

  assert.equal(walletScopeFor('broker'), 'broker')
})

test('describeChat shows enough of the key to compare, and not enough to use', () => {
  process.env.CHAT_API_KEY = 'sk-or-v1-abcdefghijklmnop'
  process.env.CHAT_MODEL = 'some/model'

  const d = describeChat('broker')
  assert.ok(d.ok)
  assert.doesNotMatch(d.keyFingerprint, /abcdefgh/, 'kalit ko\'rinib qoldi')
  assert.match(d.keyFingerprint, /^sk-o/, 'ikkita kalitni solishtirib bo\'lmaydi')
  assert.equal(JSON.stringify(d).includes(process.env.CHAT_API_KEY), false,
    'kalit describeChat natijasida bor')
})

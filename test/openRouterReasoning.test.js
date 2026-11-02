// OpenRouter A/B: the reasoning control per model family, the provider pin,
// and the latency / served-by record. No network: fetch is replaced.
// Each test names the mutation it kills.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x'
process.env.JWT_SECRET ??= 'x'.repeat(48)
const { default: appConfig } = await import('../src/config.js')
const { chatText } = await import('../scripts/seed/aiClient.js')
const { chatConfigFor, describeChat } = await import('../src/modules/chat/chatProvider.js')
const { openRouterReasoningParams, providerRouting, chatMaxTokens } = await import('../src/constants/chatBudget.js')
const { attemptFields } = await import('../scripts/evalAttempts.js')

const OR = 'https://openrouter.ai/api/v1'
const GROQ = 'https://api.groq.com/openai/v1'
const VARS = [
  'CHAT_REASONING', 'CHAT_MAX_TOKENS',
  'CHAT_GROQ_REASONING_EFFORT', 'CHAT_BROKER_REASONING_EFFORT', 'CHAT_DRIVER_REASONING_EFFORT',
  'CHAT_PROVIDER_ORDER', 'CHAT_BROKER_PROVIDER_ORDER', 'CHAT_DRIVER_PROVIDER_ORDER',
  'CHAT_BASE_URL', 'CHAT_API_KEY', 'CHAT_MODEL',
  'CHAT_BROKER_BASE_URL', 'CHAT_BROKER_API_KEY', 'CHAT_BROKER_MODEL',
  'CHAT_DRIVER_BASE_URL', 'CHAT_DRIVER_API_KEY', 'CHAT_DRIVER_MODEL',
]
const saved = {}
const realFetch = globalThis.fetch
const realWarn = console.warn
let bodies = []

beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v] }
  appConfig.chatDriverFallbackModel = null
  appConfig.chatBrokerFallbackModel = null
  bodies = []
  console.warn = () => {}
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  globalThis.fetch = realFetch
  console.warn = realWarn
})

const ok = (extra = {}) => new Response(JSON.stringify({
  choices: [{ message: { content: 'Sounds good.' }, finish_reason: 'stop' }], ...extra,
}), { status: 200 })
const thoughtOnly = () => new Response(JSON.stringify({
  choices: [{ message: { content: '', reasoning: 'thinking about it' }, finish_reason: 'length' }],
}), { status: 200 })

// Replace fetch: record each parsed body, answer from `replies` in order.
function fakeFetch(replies, delayMs = 0) {
  let i = 0
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const next = replies[Math.min(i++, replies.length - 1)]
    return typeof next === 'function' ? next() : next
  }
}
const cfg = (model, extra = {}) => ({ baseUrl: OR, apiKey: 'test-key', model, chat: 'broker', ...extra })
const messages = [{ role: 'user', content: 'hi' }]

function brokerConfig(model = 'deepseek/deepseek-v4.1-flash') {
  process.env.CHAT_BROKER_BASE_URL = OR
  process.env.CHAT_BROKER_API_KEY = 'test-key'
  process.env.CHAT_BROKER_MODEL = model
  return chatConfigFor('broker')
}

// Kills: effort and max_tokens sent together on OpenRouter, or the Groq-only
// top-level fields leaking into an OpenRouter request.
test('OpenRouter gpt-oss gets reasoning.effort only', async () => {
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('openai/gpt-oss-120b') })
  assert.deepEqual(bodies[0].reasoning, { effort: 'low' })
  assert.equal('reasoning_effort' in bodies[0], false)
  assert.equal('reasoning_format' in bodies[0], false)
})

// Kills: 'none' sent to gpt-oss, which reasons always and rejects it.
test('gpt-oss ignores CHAT_REASONING=off and never gets none', async () => {
  process.env.CHAT_REASONING = 'off'
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('openai/gpt-oss-120b') })
  assert.deepEqual(bodies[0].reasoning, { effort: 'low' })
})

// Kills: the per-chat effort being ignored on OpenRouter.
test('per-chat effort reaches the OpenRouter gpt-oss body', async () => {
  process.env.CHAT_BROKER_REASONING_EFFORT = 'medium'
  process.env.CHAT_DRIVER_REASONING_EFFORT = 'high'
  fakeFetch([ok(), ok()])
  await chatText({ messages, config: cfg('openai/gpt-oss-120b', { chat: 'broker' }) })
  await chatText({ messages, config: cfg('openai/gpt-oss-120b', { chat: 'driver' }) })
  assert.equal(bodies[0].reasoning.effort, 'medium')
  assert.equal(bodies[1].reasoning.effort, 'high')
})

// Kills: a wrong field for the family reaching the provider (a 400).
test('DeepSeek gets effort high and nothing else under reasoning', async () => {
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('deepseek/deepseek-v4.1-flash') })
  assert.deepEqual(bodies[0].reasoning, { effort: 'high' })
  assert.equal('max_tokens' in bodies[0].reasoning, false)
  assert.equal(['low', 'medium', 'none'].includes(bodies[0].reasoning.effort), false)
})

// Kills: a cap or 'none' sent to DeepSeek when thinking is switched off.
test('DeepSeek with CHAT_REASONING=off sends enabled:false only', async () => {
  process.env.CHAT_REASONING = 'off'
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('deepseek/deepseek-v4.1-flash') })
  assert.deepEqual(bodies[0].reasoning, { enabled: false })
})

// Kills: the more-room retry reintroducing reasoning.max_tokens.
test('the more-room retry keeps the family reasoning and doubles max_tokens', async () => {
  fakeFetch([thoughtOnly(), ok()])
  await chatText({ messages, config: cfg('deepseek/deepseek-v4.1-flash') })
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0].reasoning, { effort: 'high' })
  assert.deepEqual(bodies[1].reasoning, { effort: 'high' })
  assert.equal(bodies[1].max_tokens, bodies[0].max_tokens * 2)
  assert.equal(bodies[0].max_tokens, chatMaxTokens())
})

// Kills: families leaking to Groq, or unknown OpenRouter models losing the cap.
test('families are OpenRouter-only and unknown models keep the max_tokens cap', async () => {
  assert.equal(openRouterReasoningParams(GROQ, 'openai/gpt-oss-120b'), null)
  assert.equal(openRouterReasoningParams(OR, 'm'), null)
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('m') })
  assert.deepEqual(bodies[0].reasoning, { max_tokens: chatMaxTokens() - 220 })
})

// Kills: unset or blank env changing routing.
test('no provider order means no provider key', async () => {
  process.env.CHAT_BROKER_PROVIDER_ORDER = '   '
  fakeFetch([ok()])
  await chatText({ messages, config: brokerConfig() })
  assert.equal('provider' in bodies[0], false)
})

// Kills: untrimmed or empty slugs, or a pin that allows silent fallback.
test('a pinned order is trimmed and forbids fallbacks', async () => {
  process.env.CHAT_BROKER_PROVIDER_ORDER = ' deepinfra/fp8 , together ,'
  fakeFetch([ok()])
  await chatText({ messages, config: brokerConfig() })
  assert.deepEqual(bodies[0].provider, { order: ['deepinfra/fp8', 'together'], allow_fallbacks: false })
})

// Kills: the OpenRouter-only provider field being sent to Groq.
test('a provider order with a Groq base URL adds no provider key', async () => {
  assert.deepEqual(providerRouting(GROQ, ['x']), {})
  fakeFetch([ok()])
  await chatText({ messages, config: cfg('openai/gpt-oss-120b', { baseUrl: GROQ, providerOrder: ['x'] }) })
  assert.equal('provider' in bodies[0], false)
})

// Kills: a broker pin leaking into the driver chat, or a blank own var
// blocking the shared one.
test('provider order resolves per chat with the shared one as fallback', () => {
  process.env.CHAT_BASE_URL = OR
  process.env.CHAT_API_KEY = 'test-key'
  process.env.CHAT_MODEL = 'm'
  process.env.CHAT_BROKER_PROVIDER_ORDER = 'a'
  assert.deepEqual(chatConfigFor('broker').providerOrder, ['a'])
  assert.equal(chatConfigFor('driver').providerOrder, null)
  assert.deepEqual(describeChat('broker').providerOrder, ['a'])
  process.env.CHAT_PROVIDER_ORDER = 'b, c'
  process.env.CHAT_BROKER_PROVIDER_ORDER = ''
  assert.deepEqual(chatConfigFor('broker').providerOrder, ['b', 'c'])
  assert.deepEqual(chatConfigFor('driver').providerOrder, ['b', 'c'])
})

// Kills: the pin applied to the fallback model (a 404 from a host that does
// not serve it).
test('the fallback request carries no provider pin', async () => {
  const limited = () => new Response(JSON.stringify({ error: { message: 'Provider returned error' } }), { status: 429 })
  fakeFetch([limited, ok()])
  await chatText({ messages, config: cfg('deepseek/deepseek-v4.1-flash', { providerOrder: ['deepinfra'], fallbackModel: 'other/model' }) })
  assert.deepEqual(bodies[0].provider, { order: ['deepinfra'], allow_fallbacks: false })
  assert.equal(bodies[1].model, 'other/model')
  assert.equal('provider' in bodies[1], false)
})

// Kills: latency missing, or recorded only for successes.
test('every attempt records its latency, failures included', async () => {
  const seen = []
  fakeFetch([ok()], 20)
  await chatText({ messages, config: cfg('m'), onAttempt: (a) => seen.push(a) })
  assert.ok(seen[0].ms >= 15, `ms ${seen[0].ms}`)
  const bad = () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
  fakeFetch([bad], 20)
  await assert.rejects(chatText({ messages, config: cfg('m'), onAttempt: (a) => seen.push(a) }))
  assert.equal(seen[1].outcome, 'http_error')
  assert.ok(seen[1].ms >= 15, `ms ${seen[1].ms}`)
})

// Kills: a missing latency summed as 0.
test('attemptFields sums latency and keeps "none reported" as null', () => {
  assert.equal(attemptFields([{ ms: 100 }, { ms: 250 }]).latencyMs, 350)
  assert.equal(attemptFields([{ outcome: 'ok' }]).latencyMs, null)
  assert.equal(attemptFields([]).latencyMs, null)
})

// Kills: no proof that the pin took effect.
test('the host that answered is recorded as servedBy', async () => {
  const seen = []
  fakeFetch([ok({ provider: 'DeepInfra' })])
  await chatText({ messages, config: cfg('m'), onAttempt: (a) => seen.push(a) })
  assert.equal(seen[0].servedBy, 'DeepInfra')
})

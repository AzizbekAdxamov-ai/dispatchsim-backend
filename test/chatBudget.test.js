// The chat's daily budget.
//
// What is being tested is arithmetic and wording, not the database: the
// query that produces `used`, `accountUsed` and `seats` is parsed against
// the real schema by npm run sql:check. What is tested here is what those
// three numbers are allowed to mean.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CHAT_REPLY_TOKENS,
  CHAT_REPLY_MAX_CHARS,
  REASONING_ALLOWANCE,
  chatMaxTokens,
  tooLongForChat,
  PROVIDERS,
  UNKNOWN_PROVIDER,
  SAFETY_MARGIN,
  DEFAULT_CHAT_BASE_URL,
  providerFor,
  dailyBudgetFor,
  fairShare,
  budgetMessage,
  dailyCapScope,
  groqReasoningParams,
} from '../src/constants/chatBudget.js'

const OPENROUTER = 'https://openrouter.ai/api/v1'
const GROQ = 'https://api.groq.com/openai/v1'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(join(here, '..', p), 'utf8')

test('every budget sits under its provider limit, never on it', () => {
  for (const [url, p] of Object.entries(PROVIDERS)) {
    const budget = dailyBudgetFor(url)
    assert.ok(budget < p.requestsPerDay, `${p.name}: byudjet limitdan kichik emas`)
    assert.equal(budget, Math.floor(p.requestsPerDay * (1 - SAFETY_MARGIN)))
  }
})

test('an unknown base URL gets a cautious limit, not a guessed one', () => {
  // The failure this catches is a new provider silently inheriting the
  // largest number in the table.
  const unknown = providerFor('https://something-new.example/v1')
  assert.equal(unknown, UNKNOWN_PROVIDER)
  const biggest = Math.max(...Object.values(PROVIDERS).map((p) => p.requestsPerDay))
  assert.ok(unknown.requestsPerDay < biggest, 'noma\'lum provayder eng katta limitni oldi')
  assert.match(unknown.note, /PROVIDERS/)
})

test('a trailing slash is the same provider', () => {
  assert.equal(providerFor(GROQ + '/'), providerFor(GROQ))
  assert.notEqual(providerFor(GROQ), UNKNOWN_PROVIDER)
})

test('one dispatcher alone is not rationed', () => {
  for (const url of Object.keys(PROVIDERS)) {
    assert.equal(fairShare(dailyBudgetFor(url), 1), dailyBudgetFor(url))
  }
})

test('the shares never add up to more than the budget', () => {
  // The failure this catches is rounding UP: eight shares of 113 is 904
  // against a budget of 900, and the account runs out four requests before
  // the last student is told they have any left.
  for (const url of [...Object.keys(PROVIDERS), 'https://unknown.example/v1']) {
    const budget = dailyBudgetFor(url)
    for (let seats = 1; seats <= 200; seats += 1) {
      assert.ok(fairShare(budget, seats) * seats <= budget,
        `${url}: ${seats} ta ulush jami byudjetdan oshib ketdi`)
    }
  }
})

test('a share shrinks as people join, and never below zero', () => {
  const budget = dailyBudgetFor(GROQ)
  let previous = Infinity
  for (const seats of [1, 2, 5, 8, 20, 100, 5000]) {
    const share = fairShare(budget, seats)
    assert.ok(share <= previous, 'ulush kattalashib ketdi')
    assert.ok(share >= 0, 'ulush manfiy')
    previous = share
  }
})

test('a nonsense seat count is treated as one person, not as zero', () => {
  // Dividing by a seat count of zero is how a budget becomes Infinity and
  // a cap stops being a cap.
  const budget = dailyBudgetFor(GROQ)
  for (const bad of [0, -3, null, undefined, NaN, 'x']) {
    assert.equal(fairShare(budget, bad), budget, `${String(bad)} noto'g'ri ishlandi`)
  }
})

test('the two walls are told apart, and both carry their numbers', () => {
  const budget = 900
  const account = budgetMessage({ used: 3, share: 112, seats: 8, accountUsed: budget, budget, scope: 'both' })
  const mine = budgetMessage({ used: 112, share: 112, seats: 8, accountUsed: 400, budget, scope: 'both' })

  assert.notEqual(account, mine, 'ikkala to\'siq bir xil gapiryapti')
  assert.match(account, /900/)
  assert.match(mine, /112/)
  assert.match(mine, /8/)
  // Kills: the share still called messages after 055 made it requests.
  assert.match(mine, /112\/112 requests\./)

  // The account wall wins even when the personal share is untouched: a
  // student who has sent three messages is not told they used up a share
  // of 112.
  assert.doesNotMatch(account, /3\/112/)
})

test('the message states facts and passes no judgement', () => {
  const verdicts = /juda ko'p|ko'p yozdingiz|sekinlashtiring|noto'g'ri ishlatdingiz|suiiste/i
  for (const m of [
    budgetMessage({ used: 112, share: 112, seats: 8, accountUsed: 400, budget: 900, scope: 'both' }),
    budgetMessage({ used: 3, share: 112, seats: 8, accountUsed: 900, budget: 900, scope: 'driver' }),
  ]) {
    assert.doesNotMatch(m, verdicts, `hukm chiqaryapti: ${m}`)
  }
})

test('every provider number carries a source and a date', () => {
  // A contractual number with no link is a number nobody can re-check, and
  // a number nobody can re-check is a number that quietly goes stale.
  for (const [url, p] of Object.entries(PROVIDERS)) {
    assert.match(p.source ?? '', /^https:\/\//, `${url}: manba havolasi yo'q`)
    assert.match(p.checked ?? '', /^\d{4}-\d{2}-\d{2}$/, `${url}: tekshirilgan sana yo'q`)
    assert.ok(p.requestsPerDay > 0 && p.requestsPerMinute > 0, `${url}: limit raqami yo'q`)
  }
})

test('the default chat provider is one the table knows', () => {
  assert.notEqual(providerFor(DEFAULT_CHAT_BASE_URL), UNKNOWN_PROVIDER,
    'standart provayder PROVIDERS jadvalida yo\'q')
})

test('neither chat carries a daily cap of its own any more', () => {
  // The defect: two caps of 60 in two files, counting two tables, against
  // one key. If either one comes back, this test says so.
  for (const f of [
    'src/modules/brokerChat/brokerChat.service.js',
    'src/modules/driverChat/driverChat.service.js',
  ]) {
    const text = src(f)
    assert.doesNotMatch(text, /DAILY_MESSAGE_CAP/, `${f} hali o'z capiga ega`)
    assert.match(text, /assertCanSend/, `${f} umumiy byudjetni so'ramayapti`)
  }
})

test('neither chat writes a provider address of its own', () => {
  // Which provider a chat uses is a .env question. A URL in a service file
  // is a second answer to it, and the two drift.
  for (const f of [
    'src/modules/brokerChat/brokerChat.service.js',
    'src/modules/driverChat/driverChat.service.js',
  ]) {
    const text = src(f)
    assert.match(text, /chatConfigFor\('(broker|driver)'\)/, `${f} o'z sozlamasini so'ramayapti`)
    assert.doesNotMatch(text, /https:\/\/(openrouter|api\.groq)/,
      `${f} ichida qo'lda yozilgan provayder manzili bor`)
  }
  assert.match(DEFAULT_CHAT_BASE_URL, /^https:\/\//)
})

test('each chat asks the budget with its own name', () => {
  // assertCanSend(userId) without a scope counted one wallet for two keys.
  for (const [f, which] of [
    ['src/modules/brokerChat/brokerChat.service.js', 'broker'],
    ['src/modules/driverChat/driverChat.service.js', 'driver'],
  ]) {
    assert.match(src(f), new RegExp(`assertCanSend\\(userId, '${which}'\\)`),
      `${f} byudjetni o'z nomi bilan so'ramayapti`)
  }
})

test('no retired model id is left anywhere in the source', () => {
  // minimax-m3:free was the default in four files after OpenRouter
  // retired it. Every call became a 404 the code reported as the driver
  // being unreachable.
  for (const f of [
    'src/modules/brokerChat/brokerChat.service.js',
    'src/modules/driverChat/driverChat.service.js',
    'scripts/chat-diag.js',
    'scripts/chat-smoke.js',
    'scripts/chat-compare.js',
  ]) {
    assert.doesNotMatch(src(f), /minimax-m3/, `${f} ichida nafaqaga chiqqan model bor`)
  }
})

test('no script keeps a hand-written model list', () => {
  // chat-compare's candidate list named the wrong provider's models twice.
  // It asks /models now; a literal list creeping back in is this failing.
  const text = src('scripts/chat-compare.js')
  assert.match(text, /discoverCandidates/, 'modellar provayderdan so\'ralmayapti')
  assert.doesNotMatch(text, /'(openai|qwen|meta-llama|google)\/[a-z0-9.-]+'/,
    'qo\'lda yozilgan model ro\'yxati qaytib kelgan')
})


// ---------------------------------------------------------------------
// The budget sent vs the reply allowed
// ---------------------------------------------------------------------

test('the budget sent leaves room to think as well as to speak', () => {
  // nex-agi/nex-n2.5-mini:free produced 762 characters of reasoning, hit
  // the 220-token ceiling and returned an empty reply, every turn. The cap
  // was shaping the thinking, not the answer.
  delete process.env.CHAT_MAX_TOKENS
  assert.ok(chatMaxTokens() > CHAT_REPLY_TOKENS, 'yuboriladigan byudjet javob byudjetiga teng')
  assert.equal(chatMaxTokens(), CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE))
})

test('an override is honoured, and rubbish is not', () => {
  for (const [value, expected] of [
    ['2000', 2000],
    ['0', CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE)],
    ['-5', CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE)],
    ['lots', CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE)],
    ['', CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE)],
  ]) {
    process.env.CHAT_MAX_TOKENS = value
    assert.equal(chatMaxTokens(), expected, `CHAT_MAX_TOKENS="${value}"`)
  }
  delete process.env.CHAT_MAX_TOKENS
})

test('the reply is still held to three sentences, by its own rule now', () => {
  // Raising the budget without this would mean the length cap silently
  // stopped existing: the number that used to enforce it now covers the
  // model's thinking too.
  assert.equal(tooLongForChat('Still got it. $1,650 and it is yours.'), false)
  assert.equal(tooLongForChat('x'.repeat(CHAT_REPLY_MAX_CHARS)), false)
  assert.equal(tooLongForChat('x'.repeat(CHAT_REPLY_MAX_CHARS + 1)), true)
  // Leading and trailing whitespace is not length.
  assert.equal(tooLongForChat(`   ${'x'.repeat(CHAT_REPLY_MAX_CHARS)}   `), false)
  for (const notAString of [null, undefined, 42, {}]) {
    assert.equal(tooLongForChat(notAString), false, String(notAString))
  }
})

test('both chats treat an over-long reply the way they treat leaked reasoning', () => {
  // Regenerate once, then fall back in character -- not throw, and never
  // show the student a wall of text.
  for (const f of [
    'src/modules/brokerChat/brokerChat.service.js',
    'src/modules/driverChat/driverChat.service.js',
  ]) {
    const text = src(f)
    assert.match(text, /tooLongForChat\(t\)/, `${f} javob uzunligini tekshirmayapti`)
    assert.match(text, /unusable\(reply\)\) reply = FALLBACK_REPLY/, `${f} zaxira javobga tushmayapti`)
  }
})

test('no service hard-codes a token budget of its own', () => {
  for (const f of [
    'src/modules/brokerChat/brokerChat.service.js',
    'src/modules/driverChat/driverChat.service.js',
  ]) {
    const code = src(f).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    assert.doesNotMatch(code, /maxTokens:\s*\d+/, `${f} o'z token chegarasini yozib qo'ygan`)
  }
})

// Kills: reading every 429 as "the daily limit is gone". An upstream
// provider throttling one free model is not the account's cap, and
// treating it as one stops the diagnosis at the first busy model.
test('a 429 is the daily cap only when it says so', async () => {
  const { isDailyCap } = await import('../src/constants/chatBudget.js')
  assert.equal(isDailyCap('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'), true)
  assert.equal(isDailyCap('Provider returned error'), false)
  assert.equal(isDailyCap('qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly'), false)
  assert.equal(isDailyCap(undefined), false)
})

// Kills: no cap on thinking (a reasoning model spent all 2000 tokens on
// it and returned no reply -- 2026-10-06 scenario run), a cap that leaves
// the reply less than its own budget, or the field sent to a provider
// that may reject it.
// Run with CHAT_REASONING unset: the cap is what these hold, and a .env
// with CHAT_REASONING=off (2026-10-11) must not decide the result.
test('reasoning is capped so the reply keeps its budget, and only on OpenRouter', () => withReasoning(null, async () => {
  const { chatReasoningCap, chatMaxTokens, CHAT_REPLY_TOKENS } = await import('../src/constants/chatBudget.js')
  const { completionBody } = await import('../scripts/seed/aiClient.js')
  assert.equal(chatReasoningCap(OPENROUTER), chatMaxTokens() - CHAT_REPLY_TOKENS)
  assert.equal(chatReasoningCap(`${OPENROUTER}/`), chatMaxTokens() - CHAT_REPLY_TOKENS)
  assert.equal(chatReasoningCap(GROQ), null)
  assert.deepEqual(completionBody({ model: 'm', messages: [], temperature: 0.9, maxTokens: 880, reasoningMaxTokens: 660 }).reasoning, { max_tokens: 660 })
  assert.equal('reasoning' in completionBody({ model: 'm', messages: [], temperature: 0.9, maxTokens: 880 }), false)
}))

// Kills: chatText not passing the cap at all (completionBody would carry
// it, the real request would not).
// Run with CHAT_REASONING unset: the cap is what these hold, and a .env
// with CHAT_REASONING=off (2026-10-11) must not decide the result.
test('a chat request to OpenRouter carries the reasoning cap', () => withReasoning(null, async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const { chatReasoningCap } = await import('../src/constants/chatBudget.js')
  const realFetch = globalThis.fetch
  let sent = null
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'copy that' } }] }) }
  }
  try {
    const reply = await chatText({ messages: [{ role: 'user', content: 'hi' }], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' } })
    assert.equal(reply, 'copy that')
    assert.deepEqual(sent.reasoning, { max_tokens: chatReasoningCap(OPENROUTER) })
  } finally {
    globalThis.fetch = realFetch
  }
}))

// A fake provider: answers in turn from `replies`, records each body.
function fakeProvider(replies) {
  const bodies = []
  let i = 0
  const fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body))
    const r = replies[Math.min(i++, replies.length - 1)]
    return { ok: true, json: async () => r }
  }
  return { fetch, bodies }
}
const THOUGHT_ONLY = { choices: [{ message: { content: '', reasoning: 'x'.repeat(5000) }, finish_reason: 'length' }], usage: { completion_tokens: 2000 } }
const CUT_OFF = { choices: [{ message: { content: 'Shipper in Nashville is clear - you mean the' }, finish_reason: 'length' }] }
const GOOD = { choices: [{ message: { content: 'copy that' }, finish_reason: 'stop' }] }

async function withFetch(fake, fn) {
  const real = globalThis.fetch
  globalThis.fetch = fake.fetch
  try { return await fn() } finally { globalThis.fetch = real }
}

// Kills: no second try when thinking ate the budget (2026-10-06: two of
// twenty turns lost), or a second try with the same budget.
test('a reply lost to thinking is tried once more with twice the room', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const fake = fakeProvider([THOUGHT_ONLY, GOOD])
  const reply = await withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }, maxTokens: 2000 }))
  assert.equal(reply, 'copy that')
  assert.equal(fake.bodies.length, 2)
  assert.equal(fake.bodies[1].max_tokens, 4000)
})

// Kills: a second request the caller is never told about. The budget is
// counted in requests; the scenario run reported 20 when 21 were sent.
test('the caller is told about the second request, and only when there is one', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const config = { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }
  let told = 0
  await withFetch(fakeProvider([THOUGHT_ONLY, GOOD]), () => chatText({ messages: [], config, maxTokens: 2000, onRetry: () => { told += 1 } }))
  assert.equal(told, 1)
  await withFetch(fakeProvider([GOOD]), () => chatText({ messages: [], config, maxTokens: 2000, onRetry: () => { told += 1 } }))
  assert.equal(told, 1)
})

// Kills: a cut-off half sentence shown as if it were the answer.
test('a reply cut off mid-sentence is not returned; it is tried again', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const fake = fakeProvider([CUT_OFF, GOOD])
  const reply = await withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }, maxTokens: 2000 }))
  assert.equal(reply, 'copy that')
})

// Kills: retrying forever, or swallowing the second failure.
test('a second failure is thrown, after exactly two requests', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const fake = fakeProvider([THOUGHT_ONLY, THOUGHT_ONLY, GOOD])
  await assert.rejects(
    withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }, maxTokens: 2000 })),
    /reasoning but no reply/,
  )
  assert.equal(fake.bodies.length, 2)
})

// -- 055: the budget counts requests, not turns ------------------------------

// Kills: onRequest not passed to the second try (a turn that cost two
// requests charged as one), or called per chatText rather than per request.
test('every request sent is counted, the second try included', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const config = { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }
  let sent = 0
  await withFetch(fakeProvider([THOUGHT_ONLY, GOOD]), () => chatText({ messages: [], config, maxTokens: 2000, onRequest: () => { sent += 1 } }))
  assert.equal(sent, 2)
  sent = 0
  await withFetch(fakeProvider([GOOD]), () => chatText({ messages: [], config, maxTokens: 2000, onRequest: () => { sent += 1 } }))
  assert.equal(sent, 1)
})

// -- CHAT_REASONING=off (2026-10-11, for google/gemma-4-31b-it:free) --------

async function withReasoning(value, fn) {
  const before = process.env.CHAT_REASONING
  // '' rather than delete: a module imported inside fn may load .env
  // (dotenv), and dotenv fills only variables that are not set at all.
  process.env.CHAT_REASONING = value ?? ''
  try { return await fn() } finally {
    if (before == null) delete process.env.CHAT_REASONING
    else process.env.CHAT_REASONING = before
  }
}

// Kills: 'off' sent as a cap (OpenRouter would switch thinking ON), or a
// cap still sent when thinking is off.
test('reasoning off is asked for as effort "none", never as a cap', async () => {
  const { completionBody } = await import('../scripts/seed/aiClient.js')
  const { chatReasoningCap } = await import('../src/constants/chatBudget.js')
  const body = completionBody({ model: 'm', messages: [], temperature: 0.9, maxTokens: 2000, reasoningMaxTokens: 'off' })
  assert.deepEqual(body.reasoning, { effort: 'none' })
  await withReasoning('off', () => {
    assert.equal(chatReasoningCap(OPENROUTER), 'off')
    assert.equal(chatReasoningCap('https://api.groq.com/openai/v1'), null)
  })
  await withReasoning(null, () => {
    assert.equal(typeof chatReasoningCap(OPENROUTER), 'number')
  })
})

// Kills: the second try going back to a thinking cap.
test('with reasoning off, the first request and the second try both ask for none', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const fake = fakeProvider([CUT_OFF, GOOD])
  await withReasoning('off', () => withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'm' }, maxTokens: 2000 })))
  assert.equal(fake.bodies.length, 2)
  assert.deepEqual(fake.bodies[0].reasoning, { effort: 'none' })
  assert.deepEqual(fake.bodies[1].reasoning, { effort: 'none' })
})

// Kills: treating a long Retry-After as proof of a daily cap. An upstream
// model can ask for a minute without exhausting the account's day.
test('upstream 429 with a long Retry-After stops promptly as a rate limit', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => {
    sent += 1
    return { ok: false, status: 429, headers: { get: () => '60' }, text: async () => JSON.stringify({ error: { message: 'Provider returned error: temporarily rate-limited upstream' } }) }
  } }
  await assert.rejects(withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'secret-key', model: 'm' }, onRequest: () => {} })), (err) => {
    assert.equal(err.rateLimited, true)
    assert.equal(err.quotaExhausted, undefined)
    assert.equal(err.retryAfterMs, 60000)
    return true
  })
  assert.equal(sent, 1)
})

// Kills: marking every final 429 as a daily cap. With no provider proof,
// four attempts still say only that this model is rate limited.
test('ambiguous 429 after all retries is not a daily cap', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => {
    sent += 1
    return { ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'Provider returned error' } }) }
  } }
  await assert.rejects(withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'secret-key', model: 'm' } })), (err) => {
    assert.equal(err.rateLimited, true)
    assert.equal(err.quotaExhausted, undefined)
    assert.match(err.message, /attempt 4\/4/)
    return true
  })
  assert.equal(sent, 4)
})

// Kills: retrying an explicit account daily cap, spending more requests
// that cannot succeed before the provider's next daily window.
test('explicit provider daily cap stops after one request', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => {
    sent += 1
    return { ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }) }
  } }
  await assert.rejects(withFetch(fake, () => chatText({ messages: [], config: { baseUrl: OPENROUTER, apiKey: 'secret-key', model: 'm' } })), (err) => {
    assert.equal(err.quotaExhausted, true)
    assert.equal(err.rateLimited, undefined)
    assert.match(err.message, /attempt 1\/4/)
    return true
  })
  assert.equal(sent, 1)
})

function throttled(message) {
  return { ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message } }) }
}

// Kills: never falling back on a transient 429, or a fallback request that
// onRequest does not count (budget off by one), or not reporting which
// model actually answered.
test('Grace switches after one transient 429 and records the model that answered', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const models = []
  const answered = []
  let sent = 0
  const fake = { fetch: async (_url, opts) => {
    models.push(JSON.parse(opts.body).model)
    return models.length === 1 ? throttled('upstream model is busy') : { ok: true, json: async () => GOOD }
  } }
  const reply = await withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
    onRequest: () => { sent += 1 }, onModel: (model) => { answered.push(model) },
  }))
  assert.equal(reply, 'copy that')
  assert.deepEqual(models, ['primary', 'backup'])
  assert.equal(sent, 2)
  assert.deepEqual(answered, ['backup'])
})

// Kills: falling back on a daily-quota 429, spending a second request that
// cannot succeed because the quota belongs to the account, not the model.
test('an explicit daily cap never calls the fallback', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => { sent += 1; return throttled('free-models-per-day') } }
  await assert.rejects(withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  })), (err) => err.quotaExhausted === true)
  assert.equal(sent, 1)
})

// Kills: a busy fallback entering its own retry chain (or retrying the
// primary again), so one message burns 4+ requests of the daily budget.
test('a fallback 429 stops after two requests', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => { sent += 1; return throttled('upstream model is busy') } }
  await assert.rejects(withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  })), (err) => err.rateLimited === true)
  assert.equal(sent, 2)
})

// Kills: a failing fallback getting the full retry policy, a second
// backoff chain on top of the first request.
test('a fallback 503 does not start a second retry chain', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => {
    sent += 1
    return sent === 1 ? throttled('upstream model is busy')
      : { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
  } }
  await assert.rejects(withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  })), /HTTP 503/)
  assert.equal(sent, 2)
})

// Kills: a configured fallback disabling the primary's own network and 5xx
// retries, or switching models on errors that are not a model throttle.
test('a configured fallback leaves ordinary network and 5xx retries intact', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const models = []
  const fake = { fetch: async (_url, opts) => {
    models.push(JSON.parse(opts.body).model)
    if (models.length === 1) throw new Error('temporary connection issue')
    if (models.length === 2) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
    return { ok: true, json: async () => GOOD }
  } }
  const reply = await withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: OPENROUTER, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  }))
  assert.equal(reply, 'copy that')
  assert.deepEqual(models, ['primary', 'primary', 'primary'])
})

const GROQ_RPD = 'Rate limit reached for model `primary` in organization `org_x` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1.'

async function sendOnce(config, fn = () => ({ ok: true, json: async () => GOOD })) {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const bodies = []
  const fake = { fetch: async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return fn(bodies.length) } }
  const reply = await withFetch(fake, () => chatText({ messages: [], config }))
  return { reply, bodies }
}

// Kills: treating every provider's daily cap alike (Groq's per-model cap
// stopping the chat, or an unknown provider assumed per-model and spending
// a second request), or a trailing slash defeating the lookup.
test('the daily cap is per model on Groq and per account elsewhere', () => {
  assert.equal(dailyCapScope(OPENROUTER), 'account')
  assert.equal(dailyCapScope(GROQ), 'model')
  assert.equal(dailyCapScope(`${GROQ}/`), 'model')
  assert.equal(dailyCapScope('https://example.test/v1'), 'account')
  assert.equal(dailyCapScope(undefined), 'account')
})

// Kills: a Groq per-model daily cap ending the turn when the other model
// still has requests, or the fallback not being counted and reported.
test('a Groq daily cap on the primary switches to the fallback', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const models = []
  const answered = []
  let sent = 0
  const fake = { fetch: async (_url, opts) => {
    models.push(JSON.parse(opts.body).model)
    return models.length === 1 ? throttled(GROQ_RPD) : { ok: true, json: async () => GOOD }
  } }
  const reply = await withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: GROQ, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
    onRequest: () => { sent += 1 }, onModel: (m) => { answered.push(m) },
  }))
  assert.equal(reply, 'copy that')
  assert.deepEqual(models, ['primary', 'backup'])
  assert.equal(sent, 2)
  assert.deepEqual(answered, ['backup'])
})

// Kills: looping or retrying when both Groq models are capped, or losing
// the quotaExhausted flag the student-facing daily-limit message hangs on.
test('both Groq models capped for the day stops after two requests', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => { sent += 1; return throttled(GROQ_RPD) } }
  await assert.rejects(withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: GROQ, apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  })), (err) => err.quotaExhausted === true)
  assert.equal(sent, 2)
})

// Kills: assuming an unlooked-up provider counts per model, which would
// spend a second request against a cap that may cover the whole account.
test('an unknown provider daily cap never calls the fallback', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  let sent = 0
  const fake = { fetch: async () => { sent += 1; return throttled(GROQ_RPD) } }
  await assert.rejects(withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: 'https://example.test/v1', apiKey: 'x', model: 'primary', fallbackModel: 'backup' },
  })), (err) => err.quotaExhausted === true)
  assert.equal(sent, 1)
})

// Kills: qwen on Groq sending its thinking inside the reply (no
// reasoning_format), thinking at full length, 'none' ignored when
// CHAT_REASONING=off, or the OpenRouter-only reasoning object leaking in.
test('qwen on Groq asks for parsed, low-effort reasoning and no reasoning object', async () => {
  const config = { baseUrl: GROQ, apiKey: 'x', model: 'qwen/qwen3-32b' }
  const on = await withReasoning(null, () => sendOnce(config))
  assert.equal(on.bodies[0].reasoning_format, 'parsed')
  assert.equal(on.bodies[0].reasoning_effort, 'low')
  assert.equal('reasoning' in on.bodies[0], false)
  const off = await withReasoning('off', () => sendOnce(config))
  assert.equal(off.bodies[0].reasoning_format, 'parsed')
  assert.equal(off.bodies[0].reasoning_effort, 'none')
  assert.equal('reasoning' in off.bodies[0], false)
})

// Kills: sending gpt-oss the qwen parameters; it answers 400 to
// reasoning_format and to effort 'none', so the chat would fail outright.
test('gpt-oss on Groq gets effort low and never reasoning_format or none', async () => {
  const config = { baseUrl: GROQ, apiKey: 'x', model: 'openai/gpt-oss-20b' }
  for (const mode of [null, 'off']) {
    const { bodies } = await withReasoning(mode, () => sendOnce(config))
    assert.equal(bodies[0].reasoning_effort, 'low')
    assert.equal('reasoning_format' in bodies[0], false)
    assert.equal('reasoning' in bodies[0], false)
  }
})

// Kills: reasoning fields sent to a model that does not take them (a 400),
// or Groq-style fields sent to OpenRouter.
test('no Groq reasoning params for llama on Groq or qwen on OpenRouter', async () => {
  assert.deepEqual(groqReasoningParams(GROQ, 'llama-3.3-70b-versatile'), {})
  assert.deepEqual(groqReasoningParams(OPENROUTER, 'qwen/qwen3-32b'), {})
  const { bodies } = await sendOnce({ baseUrl: OPENROUTER, apiKey: 'x', model: 'qwen/qwen3-32b' })
  assert.equal('reasoning_format' in bodies[0], false)
  assert.equal('reasoning_effort' in bodies[0], false)
})

// Kills: building the fallback request from the primary's family (gpt-oss
// params sent to qwen or the reverse), or the first request carrying the
// fallback's params.
test('the fallback request carries its own model family params', async () => {
  const { chatText } = await import('../scripts/seed/aiClient.js')
  const bodies = []
  const fake = { fetch: async (_url, opts) => {
    bodies.push(JSON.parse(opts.body))
    return bodies.length === 1 ? throttled('upstream model is busy') : { ok: true, json: async () => GOOD }
  } }
  await withFetch(fake, () => chatText({
    messages: [], config: { baseUrl: GROQ, apiKey: 'x', model: 'openai/gpt-oss-20b', fallbackModel: 'qwen/qwen3-32b' },
  }))
  assert.equal(bodies.length, 2)
  assert.equal('reasoning_format' in bodies[0], false)
  assert.equal(bodies[1].reasoning_format, 'parsed')
})

// Kills: a closed <think> block reaching the student as part of the reply,
// or an unclosed one being stripped so leaksReasoning can no longer see it.
test('a closed think block is stripped and an unclosed one is left for the leak check', async () => {
  const say = (content) => () => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) })
  const config = { baseUrl: GROQ, apiKey: 'x', model: 'm' }
  assert.equal((await sendOnce(config, say('<think>x</think>\n\nCopy that'))).reply, 'Copy that')
  assert.equal((await sendOnce(config, say('<think>x'))).reply, '<think>x')
})

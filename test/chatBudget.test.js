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

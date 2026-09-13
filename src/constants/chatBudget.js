// How many model calls a day the chat may make, and how they are shared.
//
// Until 2026-09-13 there were two numbers, 60 and 60, one in
// brokerChat.service.js and one in driverChat.service.js. Neither knew
// about the other and neither knew about the provider. A student could
// send 120 messages against a key rated for 50 a day, and the 71st failed
// as an HTTP 429 inside a catch that logged to the server console -- so
// the screen said the driver was unreachable, which is not what happened.
// The driver was fine. The account was out of requests.
//
// The budget belongs to the KEY, not to the chat. Two chats on one key
// share one allowance; two chats on two keys have two. Which of those is
// true is decided by what is in .env, not by a constant here.

// -- What each provider publishes --------------------------------------
//
// These are contractual numbers, so they are written down rather than
// derived, and each is written down WITH ITS SOURCE. A number here that
// the provider has since changed is wrong, and the URL is where to check.
//
// Keyed by base URL because that is what .env actually selects. A base URL
// with no entry is not an error -- it is a provider nobody has looked up
// yet, and it gets UNKNOWN_PROVIDER below rather than a guessed number.
// Where a chat goes when .env does not say. OpenRouter, because that is
// where the free models are; Groq is now the seed generator's provider and
// nothing else. A default is a convenience for the base URL only -- the
// MODEL has no default on purpose, see readAiConfig({ requireModel }).
export const DEFAULT_CHAT_BASE_URL = 'https://openrouter.ai/api/v1'

export const PROVIDERS = Object.freeze({
  'https://openrouter.ai/api/v1': {
    name: 'OpenRouter (free models)',
    // 20 rpm. 50 requests/day under $10 lifetime credit, 1,000/day at or
    // above it. The 50 is the one that applies without credits, so it is
    // the default: a budget that assumes the larger number and is wrong
    // stops nothing.
    requestsPerMinute: 20,
    requestsPerDay: 50,
    source: 'https://openrouter.ai/docs/api-reference/limits',
    checked: '2026-09-13',
    // Written here because it is the single fact most likely to be asked
    // about this provider, and the answer is not guessable from the code.
    note: '$10 kredit sotib olinsa kuniga 1,000 ga chiqadi. '
      + "Qo'shimcha akkaunt yoki kalit limitni ko'paytirmaydi -- hujjat: "
      + '"we govern capacity globally".',
  },
  'https://api.groq.com/openai/v1': {
    name: 'Groq (developer plan)',
    requestsPerMinute: 30,
    requestsPerDay: 1000,
    source: 'https://console.groq.com/docs/rate-limits',
    checked: '2026-09-13',
    note: 'Har model uchun alohida hisoblanadi.',
  },
})

// A provider nobody has looked up. Deliberately small: an unknown provider
// is throttled to something that cannot exhaust anything, and the app says
// which base URL it does not know rather than inventing a limit for it.
export const UNKNOWN_PROVIDER = Object.freeze({
  name: 'unknown provider',
  requestsPerMinute: 10,
  requestsPerDay: 50,
  source: null,
  checked: null,
  note: "Bu base URL PROVIDERS jadvalida yo'q. Limit ehtiyot yuzasidan past olindi.",
})

export function providerFor(baseUrl) {
  const key = String(baseUrl || '').trim().replace(/\/+$/, '')
  return PROVIDERS[key] ?? UNKNOWN_PROVIDER
}

// -- How long one reply may be, and how much thinking it may cost -------
//
// These were one number, and they are two different things.
//
// max_tokens was 220, chosen as a style cap: "a broker who answers in
// three sentences reads like a person; one who writes six paragraphs
// reads like a model, and no amount of prompt wording fixes that as
// reliably as a hard cap." That reasoning is still right.
//
// It stopped working because a reasoning model spends the SAME budget on
// its own thinking first. On 2026-09-13 nex-agi/nex-n2.5-mini:free
// produced 762 characters of reasoning, hit the 220-token ceiling, and
// returned an empty reply -- every single turn. The cap was shaping the
// thinking, not the answer, and the answer never happened.
//
// So: the budget SENT is generous enough for a model to think and then
// speak, and the length of the REPLY is enforced afterwards, the same way
// a banned word or leaked reasoning is -- regenerate once, then fall back.
// A cap is not a reservation: a terse model still writes three sentences
// and stops, and is charged for three sentences.
export const CHAT_REPLY_TOKENS = 220

// How much thinking a reply is allowed to cost, as a multiple of the reply
// itself. Stated as a ratio rather than a total so it means something:
// "a model may think three times as long as it speaks". A model that needs
// more than that for a two-line haggle over a rate is the wrong model for
// a chat, and the error says so rather than the budget quietly growing.
export const REASONING_ALLOWANCE = 3

// CHAT_MAX_TOKENS overrides it, for a model that needs more room. It is an
// escape hatch, not the setting -- if it has to be raised, the honest
// answer is usually a different model.
export function chatMaxTokens() {
  const override = Number(process.env.CHAT_MAX_TOKENS)
  if (Number.isInteger(override) && override > 0) return override
  return CHAT_REPLY_TOKENS * (1 + REASONING_ALLOWANCE)
}

// The reply's own limit, in characters, because that is what we can
// actually measure on a string. Four characters per token is the usual
// rough figure for English; it is an approximation and is named as one.
// It only has to be close: this catches a model writing six paragraphs,
// not a model writing one sentence too many.
export const CHARS_PER_TOKEN = 4
export const CHAT_REPLY_MAX_CHARS = CHAT_REPLY_TOKENS * CHARS_PER_TOKEN

export function tooLongForChat(text) {
  return typeof text === 'string' && text.trim().length > CHAT_REPLY_MAX_CHARS
}

// -- Headroom ----------------------------------------------------------
//
// The app's count and the provider's count are not the same count. A
// retried call, a timeout the provider billed and the app did not record,
// another script on the same key -- each is a request the app never sees.
// And the provider's day starts at midnight UTC while these queries count
// from midnight in the database's timezone, so the two windows overlap
// rather than coincide.
//
// 10% is not a measurement. It is headroom, and it is named so nobody
// reads the resulting number as a fact about the provider.
export const SAFETY_MARGIN = 0.1

export function dailyBudgetFor(baseUrl) {
  return Math.floor(providerFor(baseUrl).requestsPerDay * (1 - SAFETY_MARGIN))
}

// -- How one key's budget is shared ------------------------------------
//
// Not by a fixed per-student cap. A fixed cap has to guess the class size,
// and a guess is exactly the kind of number this project does not write
// down: set it at 120 and eight students exhaust the account anyway; set
// it at 30 and a student working alone is stopped with the rest idle.
//
// The share is computed from who is actually dispatching today. One
// student alone gets the whole budget. Eight get an eighth each. The
// divisor is a count of real rows, so it needs no maintenance and it is
// right on a day nobody predicted.
//
// A student already past a share that shrank when others logged on is not
// billed for it and nothing is taken back -- they stop sending until
// tomorrow. Same consequence as any cap, reached without guessing how many
// people would show up.
export function fairShare(budget, activeUsersToday) {
  const seats = Math.max(1, Number(activeUsersToday) || 1)
  const total = Math.max(0, Number(budget) || 0)
  return Math.floor(total / seats)
}

// What the student is told. Numbers, not a judgement: the message states
// what the budget is, how it was divided and what they used, and leaves
// the conclusion to them.
export function budgetMessage({ used, share, seats, accountUsed, budget, scope }) {
  const whose = scope === 'both' ? 'chat' : scope === 'broker' ? 'broker chat' : 'driver chat'
  if (accountUsed >= budget) {
    return `Bugungi ${whose} byudjeti tugadi: ${accountUsed}/${budget} ta so'rov ishlatildi. Ertaga yangilanadi.`
  }
  return `Bugungi ulushingiz tugadi: ${used}/${share} ta xabar. `
    + `Bugun ${seats} ta dispecher ishlayapti, kunlik ${budget} ta so'rov shuncha kishiga bo'lingan.`
}

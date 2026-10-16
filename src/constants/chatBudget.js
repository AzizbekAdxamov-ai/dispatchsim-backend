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
    id: 'openrouter',
    // One daily cap for the whole account: when it is hit, every model refuses.
    dailyCapScope: 'account',
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
    id: 'groq',
    // Limits are counted per model: one model at its daily cap says nothing
    // about the next one.
    dailyCapScope: 'model',
    name: 'Groq (developer plan)',
    requestsPerMinute: 30,
    requestsPerDay: 1000,
    // Developer plan base limits, per model. Tokens are the wall that
    // arrives first: 200K a day is about 60 chat replies at the ~3,200
    // tokens a reply with its system prompt costs. Groq reports TPM in
    // response headers but not TPD, so the day's tokens are counted from
    // what the app recorded (chat_turn_log.attempts, 060).
    models: {
      'openai/gpt-oss-120b': { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
      'qwen/qwen3.8-27b': { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    },
    source: 'https://console.groq.com/docs/rate-limits',
    checked: '2026-10-15',
    note: 'Har model uchun alohida hisoblanadi.',
  },
})

// A provider nobody has looked up. Deliberately small: an unknown provider
// is throttled to something that cannot exhaust anything, and the app says
// which base URL it does not know rather than inventing a limit for it.
export const UNKNOWN_PROVIDER = Object.freeze({
  id: 'unknown',
  dailyCapScope: 'account',
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

// Does a daily-cap 429 cover the whole account ('account') or only the model
// that was asked ('model')? Unknown providers are assumed account-wide: the
// cautious answer is to stop rather than spend a second request.
export function dailyCapScope(baseUrl) {
  return providerFor(baseUrl).dailyCapScope
}

export function isGroq(baseUrl) {
  return providerFor(baseUrl).id === 'groq'
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

// A cap on the THINKING, so the reply always has room.
//
// max_tokens covers thinking and reply together. A reasoning model that
// thinks until the budget runs out returns no reply at all: the
// 2026-10-06 scenario run lost one turn in twenty that way ("6398 chars of
// reasoning, 2000 completion tokens of a 2000 budget"), and in the app
// that is a dispatcher with no answer. OpenRouter accepts a separate cap
// on reasoning (reasoning.max_tokens, https://openrouter.ai/docs/use-
// cases/reasoning-tokens, checked 2026-10-06; ignored by models that do
// not reason). Set to the whole budget minus one reply, the reply is
// always left its CHAT_REPLY_TOKENS whatever CHAT_MAX_TOKENS says.
// null for providers that do not take the field -- an unknown parameter
// is an error on some of them.
//
// CHAT_REASONING=off asks for no thinking at all (reasoning.effort "none",
// same docs page, checked 2026-10-11) -- for a chat model whose reasoning
// is optional, like google/gemma-4-31b-it. Sending a max_tokens cap to such
// a model is not neutral: OpenRouter infers "enabled" from it and switches
// the thinking ON. Returned as the string 'off' so the request builder
// (aiClient.completionBody) can tell "no cap" from "no thinking".
export function chatReasoningMode() {
  const raw = String(process.env.CHAT_REASONING ?? '').trim().toLowerCase()
  return raw === 'off' ? 'off' : 'on'
}

export function chatReasoningCap(baseUrl) {
  const key = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (key !== DEFAULT_CHAT_BASE_URL) return null
  if (chatReasoningMode() === 'off') return 'off'
  return Math.max(0, chatMaxTokens() - CHAT_REPLY_TOKENS)
}

// How hard a gpt-oss model thinks (CHAT_GROQ_REASONING_EFFORT, checked at
// start-up in src/config.js). Low unless the .env says medium or high.
export function groqReasoningEffort() {
  const raw = String(process.env.CHAT_GROQ_REASONING_EFFORT ?? '').trim().toLowerCase()
  return raw === 'medium' || raw === 'high' ? raw : 'low'
}

// Groq's way to keep thinking out of the reply and short
// (https://console.groq.com/docs/reasoning, checked 2026-10-13). It differs
// by model family, and a wrong field is a 400, so each family gets its own:
//   qwen     reasoning_format 'parsed' moves thinking out of content;
//            reasoning_effort 'none' turns it off, 'low' keeps it brief.
//   gpt-oss  reasoning_effort low/medium/high only (low unless
//            CHAT_GROQ_REASONING_EFFORT says otherwise); it rejects both
//            reasoning_format and 'none'.
// Anything else on Groq (llama and the like) does not reason: send nothing.
export function groqReasoningParams(baseUrl, model) {
  if (!isGroq(baseUrl)) return {}
  const name = String(model ?? '')
  if (/qwen/i.test(name)) {
    return { reasoning_format: 'parsed', reasoning_effort: chatReasoningMode() === 'off' ? 'none' : 'low' }
  }
  if (/gpt-oss/i.test(name)) return { reasoning_effort: groqReasoningEffort() }
  return {}
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

// `perDay` is CHAT_REQUESTS_PER_DAY when it is set (config.js says when
// that is honest to do), otherwise the provider's published limit.
export function dailyBudgetFor(baseUrl, perDay = null) {
  const limit = Number.isInteger(perDay) && perDay > 0 ? perDay : providerFor(baseUrl).requestsPerDay
  return Math.floor(limit * (1 - SAFETY_MARGIN))
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
  // English, like every line a student reads (2026-10-08 audit: these
  // were the only Uzbek sentences in the app's screens).
  if (accountUsed >= budget) {
    return `Today's ${whose} budget is used up: ${accountUsed}/${budget} requests. It resets tomorrow.`
  }
  // Requests, not messages: since 055 `used` counts provider requests, and
  // one message can cost more than one.
  return `Your share for today is used up: ${used}/${share} requests. `
    + `${seats} ${seats === 1 ? 'dispatcher is' : 'dispatchers are'} working today, and the ${budget} daily requests are split between them.`
}

// Where a model stands against its daily token allowance. Pure; `used` is
// what the app has recorded today (DAILY_TOKENS_SQL), which is not Groq's
// own count -- see chat-usage.js. It only warns: nothing is ever refused
// on this number. A model or provider with no published token limit gives
// `limit: null`, never a guessed one.
export const TOKEN_WARN_AT = 0.8

export function dailyTokenStatus(baseUrl, model, used) {
  const provider = providerFor(baseUrl)
  const limit = provider.models?.[model]?.tpd ?? null
  const spent = Math.max(0, Number(used) || 0)
  const pct = limit ? spent / limit : null
  return {
    limit,
    pct,
    warn: pct != null && pct >= TOKEN_WARN_AT,
    source: provider.source,
    checked: provider.checked,
  }
}

// Is a 429 OpenRouter's per-ACCOUNT daily cap on free models, or one
// model's upstream host refusing free traffic right now?
//
// Only the first means every other free model will refuse too. OpenRouter
// names its own cap ("Rate limit exceeded: free-models-per-day. Add 10
// credits to unlock 1000 free model requests per day"); an upstream
// refusal arrives as "Provider returned error" and says nothing about a
// day. scripts/chat-diag.js used to read every 429 as the first kind and
// stop -- on 2026-09-30, with five requests of fifty spent.
export function isDailyCap(message) {
  return /free-models-per-day|per[ -]day|daily/i.test(String(message ?? ''))
}

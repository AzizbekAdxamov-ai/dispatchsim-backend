// Thin, provider-agnostic client for one OpenAI-compatible chat/completions
// endpoint. No provider-specific code lives here -- Groq, OpenRouter,
// Together, Gemini's OpenAI-compat endpoint, a local Ollama, all speak this
// same shape, and config.js already resolved which one via AI_BASE_URL.
//
// The API key is only ever placed in the Authorization header of the
// outgoing request. It is never interpolated into a URL, a console line,
// or an Error message anywhere in this file -- a thrown error names the
// HTTP status and attempt number, nothing from the request or response
// body that could carry it back out.

import { chatMaxTokens, chatReasoningCap, CHAT_REPLY_TOKENS, dailyCapScope, groqReasoningParams, isDailyCap, openRouterReasoningParams, providerRouting } from '../../src/constants/chatBudget.js'
import { sleep } from './config.js'
import { parseRateLimit } from '../../src/lib/rateLimitReason.js'

const MAX_ATTEMPTS = 4

// The longest this client will ever wait between attempts. A long wait is
// not evidence of a daily cap; upstream model throttling can also last.
const MAX_BACKOFF_WAIT_MS = 30000
const BASE_DELAY_MS = 1000

// Exponential backoff for the Nth retry, used only when the server didn't
// send a Retry-After header telling us exactly how long to wait.
function backoffDelayMs(attempt) {
  return BASE_DELAY_MS * 2 ** (attempt - 1)
}

// Retry-After is either a whole number of seconds or an HTTP-date. Returns
// milliseconds to wait, or null if the header is absent/unparseable (the
// caller falls back to plain exponential backoff in that case).
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null
  const asSeconds = Number(headerValue)
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000)
  const asDate = Date.parse(headerValue)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return null
}

// A ```json ... ``` (or bare ```) fence is the single most common way a
// chat model wraps JSON even when asked for raw JSON. Strip it before
// JSON.parse ever sees the text.
function stripFences(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

// One HTTP round trip, with retry on 429/5xx honouring Retry-After.
// The provider's own explanation, and nothing else from the body.
//
// Reading error.message rather than the whole payload is the same narrow
// exception scripts/chat-diag.js makes, for the same reason: the field is
// written for a human to read, while the surrounding object can carry the
// request back verbatim. The key is removed from the result regardless,
// because "the provider would not do that" is not a guarantee anyone here
// can make about every provider this app may be pointed at.
async function safeProviderMessage(response, apiKey, maxLen = 300) {
  let text
  try {
    text = await response.text()
  } catch {
    return null
  }
  let message
  try {
    const data = JSON.parse(text)
    message = data?.error?.message ?? data?.message
  } catch {
    return null
  }
  if (typeof message !== 'string' || message.trim() === '') return null

  let out = message.trim().slice(0, maxLen)
  if (apiKey) out = out.split(apiKey).join('<KEY>')
  // Any key-shaped token, whether or not it is the one in use: a provider
  // echoing a DIFFERENT key back is still a key on someone's screen.
  out = out.replace(/\b(sk|gsk|key)-[A-Za-z0-9_-]{8,}/gi, '<KEY>')
  return out
}

// What a response says it cost, in the provider's own counts. null when the
// response carries no usage block. `reasoning` and `cached` are null rather
// than 0 when the provider does not report them: "not reported" and "none"
// are different facts.
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const prompt = num(usage.prompt_tokens)
  const completion = num(usage.completion_tokens)
  const total = num(usage.total_tokens)
  if (prompt == null && completion == null && total == null) return null
  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    reasoning: num(usage.completion_tokens_details?.reasoning_tokens),
    cached: num(usage.prompt_tokens_details?.cached_tokens),
    total: total ?? (prompt ?? 0) + (completion ?? 0),
  }
}

// Returns the assistant message's raw text content (not yet JSON-parsed).
// The request body, on its own so a test can read it without a network.
// `reasoningMaxTokens` is sent only when given (chatReasoningCap decides,
// per provider).
export function completionBody({ model, messages, temperature, maxTokens, reasoningMaxTokens = null, providerParams = {} }) {
  return {
    model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(reasoningMaxTokens === 'off'
      ? { reasoning: { effort: 'none' } }
      : reasoningMaxTokens != null ? { reasoning: { max_tokens: reasoningMaxTokens } } : {}),
    ...providerParams,
  }
}

// `onRequest` is called once per HTTP request actually sent -- every
// attempt, the backoff retries included. The daily budget is a count of
// requests (055), and the only place that knows how many went out is here.
// A 429 that was refused is counted too: whether the provider charged it is
// the provider's business, and counting high stops early rather than late.
//
// `onAttempt` is told what each of those requests came to -- status, outcome,
// the parsed 429 reason, the tokens -- for the record only. Nothing here
// decides anything from it. `firstCause` says why the first request was
// sent; the ones after it are 'backoff'.
async function requestCompletion({ system, user, messages, config, temperature = 0.8, maxTokens, reasoningMaxTokens = null, onRequest = null, onAttempt = null, beforeRequest = null, firstCause = 'first', stopOnRateLimit = false, maxAttempts = MAX_ATTEMPTS }) {
  const url = `${config.baseUrl}/chat/completions`
  // `messages` wins when given (multi-turn conversation); system/user is the
  // single-shot shape the seed generator uses. One retry/backoff
  // implementation serves both rather than a second copy for chat.
  const payloadMessages = messages ?? [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  // A family with its own reasoning control (OpenRouter gpt-oss / deepseek)
  // takes effort OR max_tokens, never both: drop the cap so completionBody
  // emits no reasoning of its own and the family object below is the only one.
  const family = openRouterReasoningParams(config.baseUrl, config.model, config.chat)
  const body = JSON.stringify(completionBody({
    model: config.model, messages: payloadMessages, temperature, maxTokens,
    reasoningMaxTokens: family ? null : reasoningMaxTokens,
    // Per model config, so a fallback from another family gets its own params.
    providerParams: {
      ...groqReasoningParams(config.baseUrl, config.model, config.chat),
      ...(family ?? {}),
      ...providerRouting(config.baseUrl, config.providerOrder),
    },
  }))

  let lastNetworkError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response
    const cause = attempt === 1 ? firstCause : 'backoff'
    let t0 = null
    const report = (status, outcome, extra = {}) => onAttempt?.({
      n: attempt, model: config.model, cause, status, outcome, rateLimit: null, usage: null,
      ms: t0 == null ? null : Date.now() - t0, ...extra,
    })
    // Script pacing belongs here: one chatText call can send several HTTP
    // requests through retry, fallback or a larger-token second try.
    await beforeRequest?.()
    onRequest?.()
    try {
      t0 = Date.now()
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      })
    } catch {
      // Network-level failure (DNS, connection refused, timeout). Retry
      // like any other transient failure; only the attempt count is
      // reported, never the underlying error object (it can echo the
      // request back, including headers, on some fetch implementations).
      lastNetworkError = new Error(`AI request failed: network error (attempt ${attempt}/${maxAttempts})`)
      report(null, 'network')
      if (attempt === maxAttempts) throw lastNetworkError
      await sleep(backoffDelayMs(attempt))
      continue
    }

    if (response.ok) {
      const data = await response.json()
      const usage = usageOf(data?.usage)
      const message = data?.choices?.[0]?.message
      let content = message?.content
      // Some models (qwen on Groq among them) put a CLOSED <think>…</think>
      // block in front of the reply. It is thinking, not the answer: strip
      // it. An UNCLOSED one is left alone on purpose -- that is a reply cut
      // inside its thinking, and leaksReasoning must still see it.
      if (typeof content === 'string') content = content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '')
      if (typeof content !== 'string' || content.trim() === '') {
        // A reasoning model spends max_tokens on its own thinking first and
        // returns what is left as content -- so a budget that is generous
        // for a three-sentence reply can still come back empty, with the
        // whole allowance sitting in `reasoning`. "no message content" is
        // true and sends whoever reads it looking in the wrong place, so
        // when that is what happened, the error says so and says how many
        // tokens went where.
        const reasoning = typeof message?.reasoning === 'string' ? message.reasoning : ''
        if (reasoning.trim() !== '') {
          const err = new Error(
            `AI returned reasoning but no reply (${reasoning.length} chars of reasoning, `
            + `${data?.usage?.completion_tokens ?? '?'} completion tokens of a ${maxTokens ?? '?'} budget). `
            + 'This model needs a larger max_tokens, a lower reasoning effort, or replacing.',
          )
          err.outOfRoom = true
          report(response.status ?? 200, 'out_of_room', { usage })
          throw err
        }
        report(response.status ?? 200, 'empty', { usage })
        throw new Error('AI response had no message content')
      }
      // Cut off mid-sentence: the budget ran out after the reply had
      // started. On 2026-10-06 Grace's reply ended "you mean the" -- a
      // half sentence is worse than none, because it looks like an answer.
      if (data?.choices?.[0]?.finish_reason === 'length') {
        const err = new Error(`AI reply was cut off at the ${maxTokens ?? '?'}-token budget (${content.trim().length} chars)`)
        err.outOfRoom = true
        report(response.status ?? 200, 'cut_off', { usage })
        throw err
      }
      // Which upstream host answered (OpenRouter names it): proof a pin took effect.
      report(response.status ?? 200, 'ok', { usage, servedBy: typeof data?.provider === 'string' ? data.provider : null })
      return content
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    // Read in full so the rate-limit reason can be parsed from the whole
    // message; what is kept and shown is still the first 300 characters.
    const fullWhy = response.status === 429 || response.status < 500
      ? await safeProviderMessage(response, config.apiKey, Infinity) : null
    const why = fullWhy == null ? null : fullWhy.slice(0, 300)
    const rateLimit = response.status === 429
      ? parseRateLimit({ status: 429, message: fullWhy, headers: response.headers, baseUrl: config.baseUrl })
      : null

    // A 429 is two different situations wearing one status code, and
    // retrying the wrong one is expensive.
    //
    // A PER-MINUTE limit says "slow down": the request will succeed in a
    // few seconds and backing off is exactly right. A PER-DAY quota says
    // "come back tomorrow": every retry is a request that cannot succeed
    // and still counts against the window. On 2026-09-10 a refresh ground
    // through 20 posting batches at 4 attempts each -- eighty requests,
    // all of them 429, all of them spent -- and then did it again on the
    // next backend restart.
    //
    // Only an explicit daily-cap message proves that the account's day is
    // spent. Retry-After is a timing hint, not a quota classification.
    if (response.status === 429 && isDailyCap(why)) {
      const err = new Error(`AI request failed with HTTP 429 (attempt ${attempt}/${maxAttempts})`)
      err.quotaExhausted = true
      err.providerMessage = why
      err.retryAfterMs = retryAfterMs
      err.rateLimit = rateLimit
      report(429, 'daily_cap', { rateLimit })
      throw err
    }

    // A long wait is not useful to someone awaiting a chat reply. Surface
    // the throttle immediately instead of blocking for up to 30 seconds.
    if (response.status === 429 && (stopOnRateLimit || (retryAfterMs != null && retryAfterMs > MAX_BACKOFF_WAIT_MS))) {
      const err = new Error(`AI provider rate limited the request with HTTP 429 (attempt ${attempt}/${maxAttempts})`)
      err.rateLimited = true
      err.providerMessage = why
      err.retryAfterMs = retryAfterMs
      err.rateLimit = rateLimit
      report(429, 'rate_limited', { rateLimit })
      throw err
    }

    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === maxAttempts) {
      // The whole body still never reaches the message -- some providers
      // echo request metadata, including the Authorization header, back in
      // error bodies. But "HTTP 400" alone is a dead end, and on
      // 2026-09-13 it cost a round trip: the model id in .env had lost a
      // prefix in a copy-paste, OpenRouter said exactly that, and the
      // thrown error said only "400".
      //
      // So ONE field is read -- the provider's own error.message -- and
      // the key is scrubbed out of it before it goes anywhere. A 4xx is
      // the request being wrong, and the request is ours to fix.
      const detail = why ?? await safeProviderMessage(response, config.apiKey)
      report(response.status, response.status === 429 ? 'rate_limited' : 'http_error', { rateLimit })
      const err = new Error(
        `AI request failed with HTTP ${response.status} (attempt ${attempt}/${maxAttempts})`
        + (detail ? `: ${detail}` : ''),
      )
      // An ambiguous 429 is still a provider refusal, but it does not
      // prove a daily cap even after all retries have been used.
      if (response.status === 429) {
        err.rateLimited = true
        err.providerMessage = detail ?? null
        err.rateLimit = rateLimit
      }
      throw err
    }

    // Capped. An unbounded sleep on the provider's word would park the
    // whole refresh -- and, through the shared client, a chat request a
    // person is waiting on -- for as long as it liked.
    report(response.status, response.status === 429 ? 'rate_limited' : 'http_error', { rateLimit })
    const wait = Math.min(retryAfterMs ?? backoffDelayMs(attempt), MAX_BACKOFF_WAIT_MS)
    await sleep(wait)
  }

  // Unreachable in practice (the loop above always returns or throws),
  // but keeps this function's return type honest for any future change.
  throw lastNetworkError ?? new Error('AI request failed after retries')
}

// Sends one chat request and returns parsed JSON. On a malformed first
// response, retries exactly once with an explicit "JSON only" instruction
// appended; a second parse failure throws rather than looping forever.
export async function chatJson({ system, user, config }) {
  const firstText = await requestCompletion({ system, user, config })
  try {
    return JSON.parse(stripFences(firstText))
  } catch {
    const retryUser = `${user}\n\nReturn only valid JSON, no prose.`
    const secondText = await requestCompletion({ system, user: retryUser, config })
    try {
      return JSON.parse(stripFences(secondText))
    } catch {
      throw new Error('AI response was not valid JSON after one retry')
    }
  }
}

// Multi-turn free-form completion — the broker conversation. Unlike
// chatJson there is no JSON to parse and no reparse retry: a broker reply
// is prose, and the caller (brokerChat.service.js) decides what to do with
// text it does not like.
//
// maxTokens is deliberately small. A broker who answers in three sentences
// reads like a person; one who writes six paragraphs reads like a model,
// and no amount of prompt wording fixes that as reliably as a hard cap.
// The budget sent, which is NOT the length the reply may be. See
// src/constants/chatBudget.js: a reasoning model spends this on its own
// thinking before it writes anything, so starving it here produced an
// empty reply every turn. The reply's length is enforced after the fact.
//
// Read through a function rather than imported as a constant so a
// CHAT_MAX_TOKENS override in .env takes effect without a restart-order
// dependency, and so chat-diag.js probes with exactly what the chat sends.
//
// One second try when the model ran out of room -- thinking that ate the
// whole budget, or a reply cut off mid-sentence. The reasoning cap is not
// honoured by every model behind OpenRouter: the 2026-10-06 runs still
// lost 2 turns of 20 with it set. The retry doubles the budget; on the
// free tier the limit is requests, not tokens, so it costs one request and
// only when the first one failed. A second failure is thrown as it is.
//
// `onRetry` is told when that second request is sent: the daily budget is
// counted in requests, and a retry nobody counts is one the count is wrong by.
//
// `onAttempt` hears about every request, numbered across the whole call
// (primary, fallback, second try). `cause` is why the call was made at all:
// 'first', or 'regenerate' when the caller is asking again for a bad reply.
export async function chatText({ messages, config, temperature = 0.9, maxTokens = chatMaxTokens(), onRetry = null, onRequest = null, onModel = null, onAttempt = null, beforeRequest = null, cause = 'first' }) {
  const cap = chatReasoningCap(config.baseUrl)
  // Only a caller that explicitly supplied a different model uses this
  // path. A short throttle is specific to the model, so it switches. A
  // proved daily cap switches only where the provider counts it per model
  // (Groq); an account-wide cap (OpenRouter, or a provider nobody has
  // looked up) means the fallback would be refused too, so it stops.
  const fallbackModel = config.fallbackModel && config.fallbackModel !== config.model
    ? config.fallbackModel : null
  let fallbackUsed = false
  let attemptNo = 0
  const track = onAttempt ? (a) => onAttempt({ ...a, n: ++attemptNo }) : null
  const complete = async (modelConfig, tokens, reasoningCap, why, stopOnRateLimit = false, maxAttempts = MAX_ATTEMPTS) => {
    const reply = await requestCompletion({
      messages, config: modelConfig, temperature, maxTokens: tokens,
      reasoningMaxTokens: reasoningCap, onRequest, onAttempt: track, beforeRequest, firstCause: why, stopOnRateLimit, maxAttempts,
    })
    onModel?.(modelConfig.model)
    return reply
  }
  const completeWithFallback = async (tokens, reasoningCap, why) => {
    try {
      return await complete(config, tokens, reasoningCap, why, Boolean(fallbackModel))
    } catch (err) {
      const perModelCap = err.quotaExhausted && dailyCapScope(config.baseUrl) === 'model'
      if (!fallbackModel || !((err.rateLimited && !err.quotaExhausted) || perModelCap)) throw err
      onRetry?.()
      fallbackUsed = true
      // A busy fallback cannot become another long retry chain. Primary
      // network and 5xx retries still follow the normal client policy.
      return complete({ ...config, model: fallbackModel, providerOrder: null }, tokens, reasoningCap, 'fallback', true, 1)
    }
  }
  try {
    return await completeWithFallback(maxTokens, cap, cause)
  } catch (err) {
    if (!err.outOfRoom || fallbackUsed) throw err
    console.warn(`[ai] ${err.message} -- retrying once with ${maxTokens * 2} tokens`)
    onRetry?.()
    return completeWithFallback(maxTokens * 2, cap == null || cap === 'off' ? cap : maxTokens * 2 - CHAT_REPLY_TOKENS, 'more_room')
  }
}

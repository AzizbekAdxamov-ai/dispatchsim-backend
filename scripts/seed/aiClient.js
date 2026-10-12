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

import { chatMaxTokens, chatReasoningCap, CHAT_REPLY_TOKENS, isDailyCap } from '../../src/constants/chatBudget.js'
import { sleep } from './config.js'

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
async function safeProviderMessage(response, apiKey) {
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

  let out = message.trim().slice(0, 300)
  if (apiKey) out = out.split(apiKey).join('<KEY>')
  // Any key-shaped token, whether or not it is the one in use: a provider
  // echoing a DIFFERENT key back is still a key on someone's screen.
  out = out.replace(/\b(sk|gsk|key)-[A-Za-z0-9_-]{8,}/gi, '<KEY>')
  return out
}

// Returns the assistant message's raw text content (not yet JSON-parsed).
// The request body, on its own so a test can read it without a network.
// `reasoningMaxTokens` is sent only when given (chatReasoningCap decides,
// per provider).
export function completionBody({ model, messages, temperature, maxTokens, reasoningMaxTokens = null }) {
  return {
    model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(reasoningMaxTokens === 'off'
      ? { reasoning: { effort: 'none' } }
      : reasoningMaxTokens != null ? { reasoning: { max_tokens: reasoningMaxTokens } } : {}),
  }
}

// `onRequest` is called once per HTTP request actually sent -- every
// attempt, the backoff retries included. The daily budget is a count of
// requests (055), and the only place that knows how many went out is here.
// A 429 that was refused is counted too: whether the provider charged it is
// the provider's business, and counting high stops early rather than late.
async function requestCompletion({ system, user, messages, config, temperature = 0.8, maxTokens, reasoningMaxTokens = null, onRequest = null, stopOnRateLimit = false, maxAttempts = MAX_ATTEMPTS }) {
  const url = `${config.baseUrl}/chat/completions`
  // `messages` wins when given (multi-turn conversation); system/user is the
  // single-shot shape the seed generator uses. One retry/backoff
  // implementation serves both rather than a second copy for chat.
  const payloadMessages = messages ?? [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const body = JSON.stringify(completionBody({
    model: config.model, messages: payloadMessages, temperature, maxTokens, reasoningMaxTokens,
  }))

  let lastNetworkError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response
    onRequest?.()
    try {
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
      if (attempt === maxAttempts) throw lastNetworkError
      await sleep(backoffDelayMs(attempt))
      continue
    }

    if (response.ok) {
      const data = await response.json()
      const message = data?.choices?.[0]?.message
      const content = message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        // A reasoning model spends max_tokens on its own thinking first and
        // returns what is left as content -- so a budget that is generous
        // for a three-sentence reply can still come back empty, with the
        // whole allowance sitting in `reasoning`. "no message content" is
        // true and sends whoever reads it looking in the wrong place, so
        // when that is what happened, the error says so and says how many
        // tokens went where.
        const reasoning = typeof message?.reasoning === 'string' ? message.reasoning : ''
        const usage = data?.usage
        if (reasoning.trim() !== '') {
          const err = new Error(
            `AI returned reasoning but no reply (${reasoning.length} chars of reasoning, `
            + `${usage?.completion_tokens ?? '?'} completion tokens of a ${maxTokens ?? '?'} budget). `
            + 'This model needs a larger max_tokens, a lower reasoning effort, or replacing.',
          )
          err.outOfRoom = true
          throw err
        }
        throw new Error('AI response had no message content')
      }
      // Cut off mid-sentence: the budget ran out after the reply had
      // started. On 2026-10-06 Grace's reply ended "you mean the" -- a
      // half sentence is worse than none, because it looks like an answer.
      if (data?.choices?.[0]?.finish_reason === 'length') {
        const err = new Error(`AI reply was cut off at the ${maxTokens ?? '?'}-token budget (${content.trim().length} chars)`)
        err.outOfRoom = true
        throw err
      }
      return content
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    const why = response.status === 429 || response.status < 500
      ? await safeProviderMessage(response, config.apiKey) : null

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
      throw err
    }

    // A long wait is not useful to someone awaiting a chat reply. Surface
    // the throttle immediately instead of blocking for up to 30 seconds.
    if (response.status === 429 && (stopOnRateLimit || (retryAfterMs != null && retryAfterMs > MAX_BACKOFF_WAIT_MS))) {
      const err = new Error(`AI provider rate limited the request with HTTP 429 (attempt ${attempt}/${maxAttempts})`)
      err.rateLimited = true
      err.providerMessage = why
      err.retryAfterMs = retryAfterMs
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
      const err = new Error(
        `AI request failed with HTTP ${response.status} (attempt ${attempt}/${maxAttempts})`
        + (detail ? `: ${detail}` : ''),
      )
      // An ambiguous 429 is still a provider refusal, but it does not
      // prove a daily cap even after all retries have been used.
      if (response.status === 429) {
        err.rateLimited = true
        err.providerMessage = detail ?? null
      }
      throw err
    }

    // Capped. An unbounded sleep on the provider's word would park the
    // whole refresh -- and, through the shared client, a chat request a
    // person is waiting on -- for as long as it liked.
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
export async function chatText({ messages, config, temperature = 0.9, maxTokens = chatMaxTokens(), onRetry = null, onRequest = null, onModel = null }) {
  const cap = chatReasoningCap(config.baseUrl)
  // Only a caller that explicitly supplied a different model uses this
  // path. An upstream throttle is specific to the model; a proved daily
  // quota belongs to the account and must never trigger another request.
  const fallbackModel = config.fallbackModel && config.fallbackModel !== config.model
    ? config.fallbackModel : null
  let fallbackUsed = false
  const complete = async (modelConfig, tokens, reasoningCap, stopOnRateLimit = false, maxAttempts = MAX_ATTEMPTS) => {
    const reply = await requestCompletion({
      messages, config: modelConfig, temperature, maxTokens: tokens,
      reasoningMaxTokens: reasoningCap, onRequest, stopOnRateLimit, maxAttempts,
    })
    onModel?.(modelConfig.model)
    return reply
  }
  const completeWithFallback = async (tokens, reasoningCap) => {
    try {
      return await complete(config, tokens, reasoningCap, Boolean(fallbackModel))
    } catch (err) {
      if (!fallbackModel || !err.rateLimited || err.quotaExhausted) throw err
      onRetry?.()
      fallbackUsed = true
      // A busy fallback cannot become another long retry chain. Primary
      // network and 5xx retries still follow the normal client policy.
      return complete({ ...config, model: fallbackModel }, tokens, reasoningCap, true, 1)
    }
  }
  try {
    return await completeWithFallback(maxTokens, cap)
  } catch (err) {
    if (!err.outOfRoom || fallbackUsed) throw err
    console.warn(`[ai] ${err.message} -- retrying once with ${maxTokens * 2} tokens`)
    onRetry?.()
    return completeWithFallback(maxTokens * 2, cap == null || cap === 'off' ? cap : maxTokens * 2 - CHAT_REPLY_TOKENS)
  }
}

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

import { chatMaxTokens } from '../../src/constants/chatBudget.js'
import { sleep } from './config.js'

const MAX_ATTEMPTS = 4

// The longest this client will ever wait between attempts. Also the line
// between "slow down" and "come back tomorrow": a provider asking for
// longer than this is out of quota, not throttling.
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
async function requestCompletion({ system, user, messages, config, temperature = 0.8, maxTokens }) {
  const url = `${config.baseUrl}/chat/completions`
  // `messages` wins when given (multi-turn conversation); system/user is the
  // single-shot shape the seed generator uses. One retry/backoff
  // implementation serves both rather than a second copy for chat.
  const payloadMessages = messages ?? [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const body = JSON.stringify({
    model: config.model,
    messages: payloadMessages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  })

  let lastNetworkError = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response
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
      lastNetworkError = new Error(`AI request failed: network error (attempt ${attempt}/${MAX_ATTEMPTS})`)
      if (attempt === MAX_ATTEMPTS) throw lastNetworkError
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
          throw new Error(
            `AI returned reasoning but no reply (${reasoning.length} chars of reasoning, `
            + `${usage?.completion_tokens ?? '?'} completion tokens of a ${maxTokens ?? '?'} budget). `
            + 'This model needs a larger max_tokens, a lower reasoning effort, or replacing.',
          )
        }
        throw new Error('AI response had no message content')
      }
      return content
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))

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
    // The provider tells us which one it is. A retry-after longer than the
    // backoff ladder could ever wait is a quota, not a rate limit.
    const quotaExhausted = response.status === 429
      && retryAfterMs != null && retryAfterMs > MAX_BACKOFF_WAIT_MS
    if (quotaExhausted) {
      const err = new Error(
        `AI quota exhausted — provider asks for ${Math.round(retryAfterMs / 1000)}s`,
      )
      err.quotaExhausted = true
      err.retryAfterMs = retryAfterMs
      throw err
    }

    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === MAX_ATTEMPTS) {
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
      const why = await safeProviderMessage(response, config.apiKey)
      const err = new Error(
        `AI request failed with HTTP ${response.status} (attempt ${attempt}/${MAX_ATTEMPTS})`
        + (why ? `: ${why}` : ''),
      )
      // A 429 that survived every retry is the provider saying no more
      // today, whatever its retry-after header claimed. Marked, because
      // the caller has to say something different about it: "cannot reach
      // the driver" is a sentence about a driver, and the driver is fine.
      //
      // This matters more than it used to. With broker and driver on
      // separate keys the app believes it has two daily budgets, but
      // OpenRouter states that it governs capacity per user across
      // accounts and keys -- so the provider may stop answering while the
      // app still thinks there is room. When the two disagree, the
      // provider wins, and the screen should say so.
      if (response.status === 429) {
        err.quotaExhausted = true
        err.providerMessage = why ?? null
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
export async function chatText({ messages, config, temperature = 0.9, maxTokens = chatMaxTokens() }) {
  return requestCompletion({ messages, config, temperature, maxTokens })
}

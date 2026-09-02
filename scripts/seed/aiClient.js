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

import { sleep } from './config.js'

const MAX_ATTEMPTS = 4
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
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('AI response had no message content')
      }
      return content
    }

    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === MAX_ATTEMPTS) {
      // Deliberately not including response.text() here -- some providers
      // echo request metadata (including auth headers) back in error
      // bodies, and that must never end up in a thrown message.
      throw new Error(`AI request failed with HTTP ${response.status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    await sleep(retryAfterMs ?? backoffDelayMs(attempt))
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
export async function chatText({ messages, config, temperature = 0.9, maxTokens = 220 }) {
  return requestCompletion({ messages, config, temperature, maxTokens })
}

// AI provider configuration for the seed generator.
//
// Mirrors the collect-errors-then-print-once pattern of src/config.js,
// but scoped to this script only: it never touches process.exit itself
// (the caller decides that) and it never logs the API key value, only
// whether one is present.
//
// Provider-agnostic by design: any OpenAI-compatible chat/completions
// endpoint works (Groq, OpenRouter, Together, Gemini's OpenAI-compat
// endpoint, a local Ollama). No provider-specific code lives here or
// anywhere else in scripts/seed/.

import 'dotenv/config'

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'
const DEFAULT_MODEL = 'qwen/qwen3.8-27b'
const DEFAULT_MAX_RPM = 25

// Required by the project plan (S4): printed once, as a single block, when
// AI_API_KEY is missing and the run is not a --dry-run. One verb differs
// from the plan's literal draft — see the coder's report: this file's own
// console output is swept by the same banned-word rule (BANNED in
// validate.js) as everything else in scripts/seed/, and the plan's original
// verb is on that list.
export const MISSING_KEY_MESSAGE = `AI seed generator cannot run:
  - AI_API_KEY is missing

Set it in backend/.env:
  AI_BASE_URL=${DEFAULT_BASE_URL}
  AI_API_KEY=<your key>
  AI_MODEL=${DEFAULT_MODEL}

Free keys: console.groq.com  |  openrouter.ai/keys
Note: older Llama models have been retired on Groq.
To try the pipeline without a key:  npm run generate:seed -- --dry-run`

// Reads AI_* env vars and validates them. Returns { config, errors }.
// `config` is null when errors is non-empty. The API key's value never
// appears in `errors` or anywhere else this function returns — only
// config.hasKey (boolean) reflects its presence.
//
// `prefix` selects the env var family, so one implementation serves both
// providers: AI_* is the seed generator (Groq, batch JSON), CHAT_* is the
// broker conversation (OpenRouter, free-form text). Splitting them matters
// because the two have completely different cost shapes — the seed is a
// predictable 22 requests a day, chat is per-message and open-ended.
// `requireModel` turns an unset model into an error instead of a fallback.
// The seed generator wants the fallback -- one provider, one model, and a
// missing var is a convenience, not a mistake. The chat does not: its
// model is chosen per deployment, it changes when a provider retires one,
// and a silent fallback there sent every request to an id that had not
// existed for weeks. The call failed as someone else's 404.
// `fallbackPrefix` lets one family inherit from another: CHAT_BROKER_MODEL
// overrides CHAT_MODEL, and anything CHAT_BROKER_* does not set comes from
// CHAT_*. That is what makes one key work without writing it twice and two
// keys work without a second code path. A variable set to the empty string
// counts as unset -- otherwise commenting a value out by emptying it would
// produce a blank base URL rather than falling through to the shared one.
export function readAiConfig({ prefix = 'AI', defaults = {}, requireModel = false, fallbackPrefix = null } = {}) {
  const errors = []
  const raw = (name) => {
    const v = process.env[name]
    return typeof v === 'string' && v.trim() !== '' ? v : undefined
  }
  const env = (suffix) => raw(`${prefix}_${suffix}`)
    ?? (fallbackPrefix ? raw(`${fallbackPrefix}_${suffix}`) : undefined)

  const baseUrl = (env('BASE_URL') || defaults.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  const rawModel = env('MODEL')
  const model = requireModel
    ? (rawModel || '').trim()
    : (rawModel || defaults.model || DEFAULT_MODEL).trim()
  const apiKey = env('API_KEY') || ''
  const hasKey = apiKey.trim() !== ''

  const rawMaxRpm = env('MAX_RPM')
  let maxRpm = DEFAULT_MAX_RPM
  if (rawMaxRpm !== undefined && rawMaxRpm.trim() !== '') {
    const parsed = Number(rawMaxRpm)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.push('AI_MAX_RPM must be a positive integer when set')
    } else {
      maxRpm = parsed
    }
  }

  if (!hasKey) {
    errors.push(`${prefix}_API_KEY is missing`)
  }

  if (baseUrl === '') {
    errors.push(`${prefix}_BASE_URL must not be blank`)
  }

  if (model === '') {
    // Name both variables. The specific one is where an override goes; the
    // shared one is where most people will actually set it, and an error
    // that names only CHAT_BROKER_MODEL sends someone looking for a
    // variable their .env does not have and was never meant to.
    const where = fallbackPrefix
      ? `${prefix}_MODEL (yoki ${fallbackPrefix}_MODEL)`
      : `${prefix}_MODEL`
    errors.push(requireModel
      ? `${where} is not set. No default on purpose: a retired model id as a `
        + 'default turns every call into someone else\'s 404. '
        + 'Run `npm run chat:diag` to see which models this key can call.'
      : `${prefix}_MODEL must not be blank`)
  }

  if (errors.length > 0) {
    return { config: null, errors }
  }

  // Minimum spacing between requests, derived from the requests-per-minute
  // budget (S7): sequential calls, never parallel.
  const requestSpacingMs = Math.ceil(60000 / maxRpm)

  return {
    config: { baseUrl, model, apiKey, maxRpm, requestSpacingMs, hasKey },
    errors: [],
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

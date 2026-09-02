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
export function readAiConfig({ prefix = 'AI', defaults = {} } = {}) {
  const errors = []
  const env = (suffix) => process.env[`${prefix}_${suffix}`]

  const baseUrl = (env('BASE_URL') || defaults.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  const model = (env('MODEL') || defaults.model || DEFAULT_MODEL).trim()
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
    errors.push(`${prefix}_MODEL must not be blank`)
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

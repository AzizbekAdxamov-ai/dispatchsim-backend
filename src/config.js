// Central configuration for the backend. Loads environment variables once,
// validates the ones the app cannot safely run without, and exposes a single
// frozen object so the rest of the codebase never touches process.env directly.

import 'dotenv/config'
import { ROLE_KEYS } from './constants/roles.js'

const errors = []

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl || databaseUrl.trim() === '') {
  errors.push('DATABASE_URL is missing')
}

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) {
  // Never log the actual value here — only its absence/length problem.
  errors.push('JWT_SECRET is missing or too short (must be at least 32 characters)')
}

// PORT is only read by server.js, which runs when the app is hosted as a
// long-lived process (local dev, Render, Railway). On a serverless host the
// platform never sets PORT and never calls app.listen() -- api/index.js
// exports the app instead. Requiring PORT there would abort the process at
// import time on every single invocation, so a missing PORT falls back to
// the default. An explicitly WRONG value is still an error worth reporting.
const rawPort = process.env.PORT
const port = rawPort ? Number(rawPort) : 4000
if (rawPort && (!Number.isInteger(port) || port <= 0)) {
  errors.push(`PORT is not a valid positive integer (got: ${rawPort})`)
}

// DEFAULT_ROLE is optional and, unlike the values above, is not required to
// run the app at all. Left unset (or blank), newly registered accounts get
// no roles granted at all (an empty roles set, activeRole: null) —
// unassigned, waiting for an administrator to grant a work area via
// PATCH /admin/users/:id, or for the student to register through an
// invite link instead. Set it only if this deployment wants signups that
// did NOT use an invite code to be granted one specific role
// automatically; an invite code's own roles always take priority over this
// when both apply (see modules/auth/auth.service.js's register()).
const rawDefaultRole = process.env.DEFAULT_ROLE
const defaultRole = rawDefaultRole && rawDefaultRole.trim() !== '' ? rawDefaultRole.trim() : null
if (defaultRole !== null && !ROLE_KEYS.includes(defaultRole)) {
  errors.push(`DEFAULT_ROLE must be one of: ${ROLE_KEYS.join(', ')} (or left blank)`)
}

// The money model, on one switch.
//
// Credit-line interest, the fleet insurance premium, and every refusal
// that comes from the balance -- the lender declining a booking, a hire or
// a truck -- all hang off this.
//
// FINANCE=off exists because the recurring charges run on the compressed
// calendar: an app left open collects interest and insurance for every
// simulated day it stayed open, and once the account drifts past the
// credit line the company is insolvent and refuses new loads, hires and
// trucks. While the rest of the app is being built that is noise, not a
// lesson. Off: the two recurring charges never run, nothing is ever
// refused for lack of money, and the balance leaves the top bar.
//
// The ledger is untouched either way. Nothing is deleted and nothing is
// reset -- switching it back on resumes against the account as it stands.
//
// A typo must not disable the money model quietly, so anything other than
// 'on' or 'off' is a configuration error rather than a falsy value.
const rawFinance = process.env.FINANCE
const finance = rawFinance && rawFinance.trim() !== '' ? rawFinance.trim().toLowerCase() : 'on'
if (finance !== 'on' && finance !== 'off') {
  errors.push(`FINANCE must be 'on' or 'off' (or left blank, which means on) (got: ${rawFinance})`)
}
const financeEnabled = finance === 'on'

// The Telegram bridge, on one switch shaped like FINANCE's.
//
// The driver chat also answers in Telegram -- but only when a bot token
// exists. An empty TELEGRAM_BOT_TOKEN is not an error: it is the module
// being OFF, and the app must run exactly as it did before the bridge
// existed. A token is the one thing that turns it on; nothing else gates it.
//
// A wrong MODE is a different kind of mistake -- not whether the bridge
// runs but HOW it listens -- and silently polling when webhook was meant
// (or the reverse) looks like a dead bot with no explanation anywhere.
// So it is validated whenever a value is present, token or no token.
const rawTelegramToken = process.env.TELEGRAM_BOT_TOKEN
const telegramToken = rawTelegramToken && rawTelegramToken.trim() !== '' ? rawTelegramToken.trim() : ''

const rawTelegramMode = process.env.TELEGRAM_MODE
const telegramMode = rawTelegramMode && rawTelegramMode.trim() !== '' ? rawTelegramMode.trim().toLowerCase() : 'poll'
if (telegramMode !== 'poll' && telegramMode !== 'webhook') {
  errors.push(`TELEGRAM_MODE must be 'poll' or 'webhook' (or left blank, which means poll) (got: ${rawTelegramMode})`)
}

// Optional extra lock: when set, the bridge only works in these chats
// (comma-separated ids; group ids are negative). Blank means the bot
// answers whichever chat finds it -- the normal arrangement for a class.
// A malformed entry is an error rather than a number nobody meant, because
// a lock that half-applies is worse than a lock that refuses to start.
const telegramAllowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter((part) => part !== '')
  .map(Number)
if (telegramAllowedChatIds.some((id) => !Number.isSafeInteger(id) || id === 0)) {
  errors.push('TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of chat ids (or left blank, which allows any chat)')
}

// Whether the driver model may SEE an incoming photo. The honest default
// is off: with it off the bot says plainly that the model cannot look at
// the picture and still delivers the caption as text. Claiming to have
// seen what the model never saw is the one response this switch exists
// to make impossible.
const rawChatDriverVision = process.env.CHAT_DRIVER_VISION
const chatDriverVision = rawChatDriverVision && rawChatDriverVision.trim() !== '' ? rawChatDriverVision.trim().toLowerCase() : 'off'
if (chatDriverVision !== 'on' && chatDriverVision !== 'off') {
  errors.push(`CHAT_DRIVER_VISION must be 'on' or 'off' (or left blank, which means off) (got: ${rawChatDriverVision})`)
}

if (errors.length > 0) {
  console.error('Invalid configuration:')
  for (const message of errors) {
    console.error(`  - ${message}`)
  }
  console.error('Check your .env file against .env.example and try again.')
  process.exit(1)
}

const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '24h'
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173'
const nodeEnv = process.env.NODE_ENV || 'development'
const isProd = nodeEnv === 'production'

// Shared secret for POST /ops/tick. Absent by default: the endpoint
// refuses to run rather than exposing the company clock to anyone who
// finds the URL. Only needed where no long-lived process exists to run
// node-cron -- i.e. serverless.
const opsTickSecret = process.env.OPS_TICK_SECRET || ''

export default {
  databaseUrl,
  opsTickSecret,
  jwtSecret,
  jwtExpiresIn,
  port,
  corsOrigin,
  isProd,
  defaultRole,
  financeEnabled,
  telegramEnabled: telegramToken !== '',
  telegramToken,
  telegramMode,
  telegramAllowedChatIds,
  chatDriverVision: chatDriverVision === 'on',
}

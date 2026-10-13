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

// Fast replies: every broker and driver answer inside a minute, end to
// end. A switch for a test day (Azizbek, 2026-10-01: "max one minute,
// today only"), not a setting to leave on -- the delays ARE the job: a
// dispatcher's skill is working four loads while nobody answers. Off is
// the default and anything but on/off stops the app, like FINANCE.
// The arithmetic is src/constants/replySpeed.js.
// CHAT_REASONING: 'off' asks the model not to think before it answers
// (src/constants/chatBudget.js chatReasoningMode). Blank or 'on' keeps the
// capped thinking a reasoning model needs.
const rawReasoning = (process.env.CHAT_REASONING ?? '').trim().toLowerCase()
if (rawReasoning !== '' && rawReasoning !== 'on' && rawReasoning !== 'off') {
  errors.push(`CHAT_REASONING must be 'on' or 'off' (or left blank, which means on) (got: ${process.env.CHAT_REASONING})`)
}

const rawFast = process.env.CHAT_FAST_REPLIES
const fast = rawFast && rawFast.trim() !== '' ? rawFast.trim().toLowerCase() : 'off'
if (fast !== 'on' && fast !== 'off') {
  errors.push(`CHAT_FAST_REPLIES must be 'on' or 'off' (or left blank, which means off) (got: ${rawFast})`)
}

// How many chat requests a day the provider really allows this account.
// Blank means the provider's published number (src/constants/chatBudget.js
// PROVIDERS -- for OpenRouter's free models, 50). Set it ONLY to a number
// the provider has actually granted: OpenRouter raises free models to
// 1,000 a day once $10 of credit has been bought, and the app cannot see
// that purchase. A number higher than the truth does not buy requests; it
// only moves the wall from the app's clear message to the provider's 429.
const rawPerDay = (process.env.CHAT_REQUESTS_PER_DAY ?? '').trim()
const chatRequestsPerDay = rawPerDay === '' ? null : Number(rawPerDay)
if (rawPerDay !== '' && (!Number.isInteger(chatRequestsPerDay) || chatRequestsPerDay <= 0)) {
  errors.push(`CHAT_REQUESTS_PER_DAY must be a whole number above zero, or blank (got: ${rawPerDay})`)
}

// Telegram. Only `npm run bot` reads any of this -- the API server runs
// exactly as it did before the bot existed, and starts with all three
// blank.
//
// It used to be the other way round: the bot was a second process with
// its own .env, and what stood here was a URL and a shared key so the
// two could believe each other over HTTP. That was one moving part more
// than the job has -- the bot needs the database and the model client,
// both of which are here -- so on 2026-09-29 it moved in. The token
// moved with it. That is the one real cost of the merge: this process
// now holds the bot token, where before it could not have leaked it if
// it tried. It is never logged (src/constants/telegramMeta.js prints a
// fingerprint), and nothing outside src/bot reads it.
const telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()

// Which group the bot answers. Required when the token is set, and the
// whole of what /link used to do: a code bound a chat to one of many
// student accounts, and there is one dispatcher and one group now.
const rawTelegramChatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim()
const telegramChatId = rawTelegramChatId === '' ? null : Number(rawTelegramChatId)
if (rawTelegramChatId !== '' && (!Number.isSafeInteger(telegramChatId) || telegramChatId === 0)) {
  errors.push(`TELEGRAM_CHAT_ID must be a chat id -- a whole number, negative for a group (got: ${rawTelegramChatId})`)
}

// Whose threads the group is. The conversations the bot writes belong to
// a user account, the same ones the app's Driver chat shows.
const telegramDispatcherEmail = (process.env.TELEGRAM_DISPATCHER_EMAIL ?? '').trim().toLowerCase()

// One fixed driver for the whole group. Set: every message that does not
// name a recipient goes to this driver -- no /d, no roster question, the
// group just talks and one person answers. Blank: the group picks with
// /d or is asked who it means.
const rawTelegramDriverName = (process.env.TELEGRAM_DRIVER_NAME ?? '').trim()
const telegramDriverName = rawTelegramDriverName === '' ? null : rawTelegramDriverName

// All three or none. A half-configured bot fails at the first message
// with nothing in the boot log to explain it, which is the failure this
// check exists to make impossible.
const telegramParts = [
  ['TELEGRAM_BOT_TOKEN', telegramBotToken !== ''],
  ['TELEGRAM_CHAT_ID', rawTelegramChatId !== ''],
  ['TELEGRAM_DISPATCHER_EMAIL', telegramDispatcherEmail !== ''],
]
const telegramSet = telegramParts.filter(([, present]) => present)
if (telegramSet.length > 0 && telegramSet.length < telegramParts.length) {
  const missing = telegramParts.filter(([, present]) => !present).map(([name]) => name)
  errors.push(`the bot needs all of TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and TELEGRAM_DISPATCHER_EMAIL, or none of them (missing: ${missing.join(', ')})`)
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

// Second model each chat may try once when its primary is throttled
// by the provider (a transient 429). Blank = no fallback at all: the chat
// surfaces the provider-busy error with no second request. Any other value
// is taken as a model id; the provider decides whether it exists.
const chatDriverFallbackModel = (process.env.CHAT_DRIVER_FALLBACK_MODEL ?? '').trim()
const chatBrokerFallbackModel = (process.env.CHAT_BROKER_FALLBACK_MODEL ?? '').trim()

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
  chatFastReplies: fast === 'on',
  chatRequestsPerDay,
  telegramEnabled: telegramSet.length === telegramParts.length,
  telegramBotToken,
  telegramChatId,
  telegramDispatcherEmail,
  telegramDriverName,
  chatDriverVision: chatDriverVision === 'on',
  chatDriverFallbackModel: chatDriverFallbackModel === '' ? null : chatDriverFallbackModel,
  chatBrokerFallbackModel: chatBrokerFallbackModel === '' ? null : chatBrokerFallbackModel,
}

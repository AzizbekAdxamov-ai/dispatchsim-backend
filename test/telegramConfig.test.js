// The Telegram bridge's one switch, and what the other settings mean.
//
// The money model got its own switch file (test/financeSwitch.test.js)
// because a quiet default had once left the company insolvent overnight.
// This is the same kind of file for a different quiet default: a bridge
// that ignores its configuration is a bot that sits in a group saying
// nothing, which looks exactly like a broken bot to whoever is waiting
// for a reply.
//
// Every test names the mutation it kills. None of them needs a database
// or a network: config.js is read in a child process (the same pattern
// financeSwitch.test.js uses), and describeTelegram is a pure function
// over the config object.
//
// The token is never written here, not even a fake one that looks real.
// The values below are placeholders shaped like tokens only so that
// slice/length arithmetic has something to chew on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeTelegram, TELEGRAM_MODES } from '../src/constants/telegramMeta.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// config.js is read in a child process, because it is evaluated once at
// import and reads process.env then. Hermetic on purpose: DOTENV_CONFIG_PATH
// points at a file that does not exist, so the developer's own .env cannot
// decide the outcome of a test about defaults.
function configWith(overrides = {}) {
  const env = { ...process.env }
  delete env.TELEGRAM_BOT_TOKEN
  delete env.TELEGRAM_MODE
  delete env.TELEGRAM_ALLOWED_CHAT_IDS
  delete env.CHAT_DRIVER_VISION
  env.DOTENV_CONFIG_PATH = join(root, '.env.does-not-exist')
  env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x'
  env.JWT_SECRET = 'x'.repeat(48)
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value
  }
  const script = [
    "import c from './src/config.js';",
    "import { describeTelegram } from './src/constants/telegramMeta.js';",
    'process.stdout.write(JSON.stringify({ config: c, described: describeTelegram(c) }))',
  ].join('\n')
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim())
}

// Kills: `telegramEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN)` — the
// version where a whitespace-only token turns the bridge on and every
// API call then fails with an error nobody can see from the boot log.
test('an empty or whitespace TELEGRAM_BOT_TOKEN leaves the bridge off', () => {
  for (const value of [undefined, '', '   ']) {
    const { config, described } = configWith({ TELEGRAM_BOT_TOKEN: value })
    assert.equal(config.telegramEnabled, false, `expected off for ${JSON.stringify(value)}`)
    assert.equal(config.telegramToken, '')
    assert.equal(described.ok, false)
    assert.match(described.reason, /bridge is off/)
  }
})

// Kills: dropping the .trim() on the token, which would ship ' abc123 '
// to Telegram as a bearer credential and fail every call.
test('a token is trimmed, and its fingerprint shows length without the value', () => {
  const { config, described } = configWith({ TELEGRAM_BOT_TOKEN: '  abcd1234:rest-of-token  ' })
  assert.equal(config.telegramEnabled, true)
  assert.equal(config.telegramToken, 'abcd1234:rest-of-token')
  assert.equal(described.ok, true)
  assert.equal(described.tokenFingerprint, 'abcd…(22)')
  assert.ok(!described.tokenFingerprint.includes('rest-of-token'))
})

// Kills: `mode = process.env.TELEGRAM_MODE || 'poll'` without validation —
// TELEGRAM_MODE=webhok would silently poll, the webhook never arrives,
// and the bot looks dead with nothing in any log saying why.
test("a TELEGRAM_MODE that is neither poll nor webhook refuses to start", () => {
  let err = null
  try {
    configWith({ TELEGRAM_MODE: 'webhok' })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'expected the process to exit non-zero')
  assert.equal(err.status, 1)
  assert.match(err.stderr, /TELEGRAM_MODE must be 'poll' or 'webhook'/)
  assert.match(err.stderr, /got: webhok/)
})

// Kills: dropping .trim() or .toLowerCase() on the mode. A value typed
// into a .env arrives with whatever case and spacing the person used.
test('TELEGRAM_MODE is read case- and whitespace-insensitively, blank means poll', () => {
  assert.equal(configWith({ TELEGRAM_MODE: ' WEBHOOK ' }).config.telegramMode, 'webhook')
  assert.equal(configWith({ TELEGRAM_MODE: 'Poll' }).config.telegramMode, 'poll')
  assert.equal(configWith({ TELEGRAM_MODE: '' }).config.telegramMode, 'poll')
  assert.equal(configWith({}).config.telegramMode, 'poll')
})

// Kills: `Number(part) || 0` and its cousins — a typo'd id ('-100abc')
// silently becoming 0, which matches no real chat and would lock the
// bot out of everywhere while looking configured.
test('a non-numeric TELEGRAM_ALLOWED_CHAT_IDS entry refuses to start', () => {
  let err = null
  try {
    configWith({ TELEGRAM_ALLOWED_CHAT_IDS: '-1001234, -100abc' })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'expected the process to exit non-zero')
  assert.equal(err.status, 1)
  assert.match(err.stderr, /TELEGRAM_ALLOWED_CHAT_IDS/)
})

// Kills: split(',') without filtering empties — 'a, b,' producing a 0 in
// the list and the allow-lock never matching anything.
test('allowed chat ids parse to a list of numbers; blank means any chat', () => {
  const { config } = configWith({ TELEGRAM_ALLOWED_CHAT_IDS: ' -1001234, 42 ' })
  assert.deepEqual(config.telegramAllowedChatIds, [-1001234, 42])
  assert.equal(configWith({ TELEGRAM_ALLOWED_CHAT_IDS: '' }).config.telegramAllowedChatIds.length, 0)
})

// Kills: defaulting vision to on — a model that cannot see images would
// be sent them anyway, and its reply would read as if it had looked.
test('CHAT_DRIVER_VISION defaults to off and rejects anything but on/off', () => {
  assert.equal(configWith({}).config.chatDriverVision, false)
  assert.equal(configWith({ CHAT_DRIVER_VISION: ' ON ' }).config.chatDriverVision, true)
  assert.equal(configWith({ CHAT_DRIVER_VISION: 'off' }).config.chatDriverVision, false)
  let err = null
  try {
    configWith({ CHAT_DRIVER_VISION: 'true' })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'expected the process to exit non-zero')
  assert.match(err.stderr, /CHAT_DRIVER_VISION must be 'on' or 'off'/)
})

// Kills: describeTelegram reporting ok:true for a disabled bridge, which
// would make the boot log announce a bot that does not exist.
test('describeTelegram describes an enabled bridge without leaking the token', () => {
  const { described } = configWith({ TELEGRAM_BOT_TOKEN: 'abcd1234:rest', TELEGRAM_ALLOWED_CHAT_IDS: '-100,42' })
  assert.equal(described.ok, true)
  assert.equal(described.mode, 'poll')
  assert.equal(described.allowedChats, 2)
  assert.equal(described.vision, false)
})

// The mode list is the validation list. Kills: adding a mode to config.js
// without it being accepted here (or vice versa), the two drifting apart.
test('TELEGRAM_MODES is exactly the two modes config accepts', () => {
  assert.deepEqual([...TELEGRAM_MODES], ['poll', 'webhook'])
})

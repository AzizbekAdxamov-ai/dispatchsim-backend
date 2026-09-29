// The bot's switch, now that it lives in this project (`npm run bot`).
//
// The money model got its own switch file (test/financeSwitch.test.js)
// because a quiet default had once left the company insolvent overnight.
// This is the same kind of file for a different quiet default: a bot that
// ignores its configuration is a bot sitting in a group saying nothing,
// which looks exactly like a broken bot to whoever is waiting for a
// reply.
//
// Three values turn it on: the token, the group it sits in, and whose
// threads the group is. A token ALONE is the classic half-configuration:
// the process boots, Telegram knows it, and the first message dies with
// nowhere to say anything -- which is why all three or none is checked
// here rather than left to whoever reads the boot log.
//
// Every test names the mutation it kills. None needs a database or a
// network: config.js is read in a child process (the pattern
// financeSwitch.test.js uses) and describeTelegram is pure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const TOKEN = '1234567890:AA' + 'x'.repeat(35)
const EMAIL = 'dispatch@example.com'

// Hermetic: DOTENV_CONFIG_PATH points at a file that does not exist, so
// the developer's own .env cannot decide the outcome of a test about
// defaults.
function configWith(overrides = {}) {
  const env = { ...process.env }
  delete env.TELEGRAM_BOT_TOKEN
  delete env.TELEGRAM_CHAT_ID
  delete env.TELEGRAM_DISPATCHER_EMAIL
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

function startupError(overrides) {
  try {
    configWith(overrides)
  } catch (err) {
    return { status: err.status, stderr: err.stderr }
  }
  return null
}

// Kills: turning the bot on from a token alone, or letting a blank .env
// be read as a configuration error. Only all-three-blank is "off" -- the
// ordinary way the app runs without the bot -- and it must not exit.
test('nothing configured means the bot is off, and says so', () => {
  const { config, described } = configWith()
  assert.equal(config.telegramEnabled, false)
  assert.equal(described.ok, false)
  assert.match(described.reason, /TELEGRAM_BOT_TOKEN/)

  const spaced = configWith({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '  ' })
  assert.equal(spaced.config.telegramEnabled, false)
})

// Kills: letting a half-configured bot boot and fail at the first
// message instead of at startup. Either all three, or none -- and each
// partial combination names what is missing.
test('half a bot refuses to start', () => {
  const cases = [
    [{ TELEGRAM_BOT_TOKEN: TOKEN }, /TELEGRAM_CHAT_ID/],
    [{ TELEGRAM_CHAT_ID: '-100' }, /TELEGRAM_BOT_TOKEN/],
    [{ TELEGRAM_DISPATCHER_EMAIL: EMAIL }, /TELEGRAM_BOT_TOKEN/],
    [{ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100' }, /TELEGRAM_DISPATCHER_EMAIL/],
    [{ TELEGRAM_CHAT_ID: '-100', TELEGRAM_DISPATCHER_EMAIL: EMAIL }, /TELEGRAM_BOT_TOKEN/],
  ]
  for (const [overrides, missing] of cases) {
    const err = startupError(overrides)
    assert.ok(err, `${Object.keys(overrides).join('+')} yolg'iz ishga tushyapti`)
    assert.equal(err.status, 1)
    assert.match(err.stderr, missing)
  }
})

// Kills: accepting a chat id that is not one. A group id is a whole
// number, negative for a group; anything else is a typo, and a typo must
// not become "the bot answers whichever chat it finds itself in".
test('a malformed chat id refuses to start', () => {
  const err = startupError({
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: 'not-a-chat',
    TELEGRAM_DISPATCHER_EMAIL: EMAIL,
  })
  assert.ok(err)
  assert.match(err.stderr, /TELEGRAM_CHAT_ID/)

  const zero = startupError({
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '0',
    TELEGRAM_DISPATCHER_EMAIL: EMAIL,
  })
  assert.ok(zero)
  assert.match(zero.stderr, /TELEGRAM_CHAT_ID/)
})

// Kills: a chat id parsed as a string (compared later against Telegram's
// number) or a float.
test('the chat id parses to a number', () => {
  const { config } = configWith({
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: ' -100500 ',
    TELEGRAM_DISPATCHER_EMAIL: EMAIL,
  })
  assert.equal(config.telegramChatId, -100500)
  assert.equal(config.telegramEnabled, true)
})

// Kills: printing the token in the boot log or a diagnostic. Four
// characters and the length is enough to see at a glance which bot is
// running; the rest is the secret.
test('the diagnostic shows the token is there without showing it', () => {
  const { described } = configWith({
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100500',
    TELEGRAM_DISPATCHER_EMAIL: EMAIL,
  })
  assert.equal(described.ok, true)
  assert.equal(described.chatId, -100500)
  assert.equal(described.dispatcherEmail, EMAIL)
  assert.equal(described.tokenFingerprint, `${TOKEN.slice(0, 4)}…(${TOKEN.length})`)
  assert.equal(described.tokenFingerprint.includes(TOKEN.slice(6)), false)
  // And nothing anywhere in the diagnostic is the token itself.
  assert.equal(JSON.stringify(described).includes(TOKEN), false)
})

// Kills: defaulting vision ON, or accepting a typo as off. Claiming to
// have seen a photo the model never saw is the one thing this switch
// exists to prevent, and `CHAT_DRIVER_VISION=yes` must not quietly mean
// no.
test('vision defaults to off and rejects anything but on/off', () => {
  assert.equal(configWith().config.chatDriverVision, false)
  assert.equal(
    configWith({
      TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100500',
      TELEGRAM_DISPATCHER_EMAIL: EMAIL, CHAT_DRIVER_VISION: ' ON ',
    }).config.chatDriverVision,
    true,
  )
  const err = startupError({ CHAT_DRIVER_VISION: 'yes' })
  assert.ok(err)
  assert.match(err.stderr, /CHAT_DRIVER_VISION/)
})

// Kills: reading the fixed driver's name with surrounding whitespace or
// turning a blank line into the string "null". The boot check resolves
// this name against the roster, so what arrives here has to be exactly
// what .env said -- or nothing at all.
test('TELEGRAM_DRIVER_NAME trims to a name or to nothing', () => {
  const named = configWith({ TELEGRAM_DRIVER_NAME: '  Grace Lindqvist  ' })
  assert.equal(named.config.telegramDriverName, 'Grace Lindqvist')
  const blank = configWith({ TELEGRAM_DRIVER_NAME: '   ' })
  assert.equal(blank.config.telegramDriverName, null)
  assert.equal(configWith().config.telegramDriverName, null)
})

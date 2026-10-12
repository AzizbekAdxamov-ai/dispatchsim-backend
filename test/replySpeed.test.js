// Fast replies (CHAT_FAST_REPLIES=on): every answer inside a minute.
//
// A switch for a test day with a second person in the group (Azizbek,
// 2026-10-01). What has to hold while it is on: nothing waits past the
// minute, and the ORDER of the waits survives -- an A broker still
// answers before a D broker, a driver with no signal is still last --
// because the order is what the timing teaches. What has to hold while
// it is off: nothing changes at all.
//
// Every test names the mutation it kills. None needs a database; the
// config tests read config.js in a child process, the way
// botConfig.test.js does, so the developer's own .env decides nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FAST_END_TO_END_SEC,
  FAST_FLOOR_SEC,
  BROKER_THREAD_POLL_SEC,
  BROKER_FAST_CAP_SEC,
  DRIVER_FAST_CAP_SEC,
  tableSpan,
  compressDelay,
} from '../src/constants/replySpeed.js'
import { TICK_SEC, TYPING_SHOWN_MS } from '../src/bot/outgoing.js'
import {
  replyDelaySec,
  REPLY_DELAY_SEC,
  QUIET_DELAY_SEC,
  BROKER_SPAN,
} from '../src/modules/brokerChat/replyTiming.js'
import {
  driverReplyDelaySec,
  DRIVER_REPLY_SEC,
  NO_SIGNAL_DELAY_SEC,
  DRIVER_SPAN,
} from '../src/modules/driverChat/driverChat.replyTiming.js'
import { dailyBudgetFor, SAFETY_MARGIN, PROVIDERS } from '../src/constants/chatBudget.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// rng that returns the given values in turn, then repeats the last one.
function seq(...values) {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}
const STEPS = Array.from({ length: 21 }, (_, i) => i / 20)

// -- The caps ---------------------------------------------------------

// Kills: a cap typed as 60 (or any number) instead of derived. The broker
// reply is SEEN at the next thread poll, so the delay may only use what
// the poll leaves of the minute.
test('the broker cap is the minute minus the thread poll', () => {
  assert.equal(BROKER_FAST_CAP_SEC + BROKER_THREAD_POLL_SEC, FAST_END_TO_END_SEC)
  assert.equal(BROKER_FAST_CAP_SEC, 54)
})

// Kills: BROKER_THREAD_POLL_SEC drifting from the page that actually
// polls. If BrokerChat.jsx changes its interval, this fails and says where.
test('the thread poll it subtracts is the one the broker page uses', () => {
  const page = readFileSync(join(root, '..', 'frontend', 'src', 'pages', 'BrokerChat.jsx'), 'utf8')
  const m = page.match(/useResource\(fetchThread,[^)]*pollMs:\s*(\d+)/)
  assert.ok(m, 'BrokerChat.jsx no longer polls the thread with useResource(fetchThread, ..., { pollMs })')
  assert.equal(Number(m[1]) / 1000, BROKER_THREAD_POLL_SEC)
})

// Kills: forgetting the "typing…" the bot shows first, or the tick it
// waits for. Both are imported, so the cap moves with them.
test('the driver cap is the minute minus the bot tick and the typing it shows', () => {
  assert.equal(DRIVER_FAST_CAP_SEC, FAST_END_TO_END_SEC - TICK_SEC - Math.ceil(TYPING_SHOWN_MS / 1000))
  assert.equal(DRIVER_FAST_CAP_SEC, 40)
})

// -- The arithmetic ---------------------------------------------------

// Kills: tableSpan reading only the first range, or the last.
test('tableSpan covers the lowest low and the highest high, in any order', () => {
  assert.deepEqual(tableSpan([60, 120], [20, 60], [600, 900], [150, 300]), [20, 900])
  assert.deepEqual(BROKER_SPAN, [20, 900])
  assert.deepEqual(DRIVER_SPAN, [20, 720])
})

// Kills: floor and cap swapped, a missing clamp, or the proportion
// inverted (slow mapped to fast).
test('compressDelay maps the span onto [floor, cap] in proportion and clamps', () => {
  assert.equal(compressDelay(20, [20, 900], 54), FAST_FLOOR_SEC)
  assert.equal(compressDelay(900, [20, 900], 54), 54)
  assert.equal(compressDelay(460, [20, 900], 54), Math.round((FAST_FLOOR_SEC + 54) / 2))
  assert.equal(compressDelay(5000, [20, 900], 54), 54)
  assert.equal(compressDelay(0, [20, 900], 54), FAST_FLOOR_SEC)
})

// Kills: a degenerate span ([x, x]) dividing by zero into NaN.
test('compressDelay on a span with no width still returns a number inside the window', () => {
  assert.equal(compressDelay(30, [30, 30], 54), 30)
  assert.equal(compressDelay(300, [300, 300], 54), 54)
})

// Kills: any non-monotonic mapping. Order is the point of compressing
// instead of capping.
test('compressDelay never puts a longer wait before a shorter one', () => {
  let prev = -Infinity
  for (let s = 20; s <= 900; s += 7) {
    const c = compressDelay(s, [20, 900], 54)
    assert.ok(c >= prev, `${s}s compressed to ${c}, below the previous ${prev}`)
    prev = c
  }
})

// -- Broker -----------------------------------------------------------

// Kills: fast mode leaking into the default path. Off is the job.
test('broker: with fast off the delay is exactly the table draw', () => {
  for (const r of Object.keys(REPLY_DELAY_SEC)) {
    const [lo, hi] = REPLY_DELAY_SEC[r]
    // first rng value 0.99 skips the quiet roll for every rating
    assert.equal(replyDelaySec(r, seq(0.99, 0.5), false), Math.round(lo + 0.5 * (hi - lo)))
  }
  assert.equal(replyDelaySec('D', seq(0, 0.5), false), Math.round(QUIET_DELAY_SEC[0] + 0.5 * (QUIET_DELAY_SEC[1] - QUIET_DELAY_SEC[0])))
})

// Kills: fast mode that only clamps the top (an A broker unchanged at
// 20-60 would still be inside the minute, so check against the formula),
// or that ignores the switch.
test('broker: with fast on every draw lands in [floor, cap] and is the compressed table draw', () => {
  for (const r of Object.keys(REPLY_DELAY_SEC)) {
    for (const x of STEPS) {
      const slow = replyDelaySec(r, seq(0.99, x), false)
      const fast = replyDelaySec(r, seq(0.99, x), true)
      assert.equal(fast, compressDelay(slow, BROKER_SPAN, BROKER_FAST_CAP_SEC))
      assert.ok(fast >= FAST_FLOOR_SEC && fast <= BROKER_FAST_CAP_SEC, `${r} at ${x}: ${fast}s`)
    }
  }
  const quiet = replyDelaySec('D', seq(0, 1), true)
  assert.ok(quiet <= BROKER_FAST_CAP_SEC, `quiet broker at ${quiet}s`)
})

// Kills: a flat cap (everyone at 54) -- the slowest A must still beat
// the quickest quiet broker, and the quickest D must not beat the
// quickest A.
test('broker: fast mode keeps who is quick and who goes quiet', () => {
  const slowestA = replyDelaySec('A', seq(0.99, 1), true)
  const quickestQuiet = replyDelaySec('D', seq(0, 0), true)
  assert.ok(slowestA < quickestQuiet, `A ${slowestA}s vs quiet ${quickestQuiet}s`)
  assert.ok(replyDelaySec('A', seq(0.99, 0), true) < replyDelaySec('D', seq(0.99, 0), true))
})

// -- Driver -----------------------------------------------------------

// Kills: fast mode leaking into the default path.
test('driver: with fast off the delay is exactly the table draw', () => {
  for (const s of Object.keys(DRIVER_REPLY_SEC)) {
    const [lo, hi] = DRIVER_REPLY_SEC[s]
    assert.equal(driverReplyDelaySec(s, seq(0.99, 0.5), false), Math.round(lo + 0.5 * (hi - lo)))
  }
})

// Kills: the driver using the broker's cap (54 + tick + typing is past
// the minute), or ignoring the switch.
test('driver: with fast on every draw lands in [floor, cap], no signal included', () => {
  for (const s of Object.keys(DRIVER_REPLY_SEC)) {
    for (const x of STEPS) {
      const slow = driverReplyDelaySec(s, seq(0.99, x), false)
      const fast = driverReplyDelaySec(s, seq(0.99, x), true)
      assert.equal(fast, compressDelay(slow, DRIVER_SPAN, DRIVER_FAST_CAP_SEC))
      assert.ok(fast >= FAST_FLOOR_SEC && fast <= DRIVER_FAST_CAP_SEC, `${s} at ${x}: ${fast}s`)
    }
  }
  const noSignal = driverReplyDelaySec('driving', seq(0, 1), true)
  assert.equal(noSignal, DRIVER_FAST_CAP_SEC)
  assert.ok(driverReplyDelaySec('driving', seq(0, 0), true) > driverReplyDelaySec('resting', seq(0.99, 1), true))
  assert.equal(NO_SIGNAL_DELAY_SEC[1], DRIVER_SPAN[1])
})

// -- The budget override ----------------------------------------------

const OPENROUTER = 'https://openrouter.ai/api/v1'

// Kills: the override ignored, or applied without the safety margin.
test('CHAT_REQUESTS_PER_DAY replaces the provider number, margin still applied', () => {
  assert.equal(dailyBudgetFor(OPENROUTER), Math.floor(PROVIDERS[OPENROUTER].requestsPerDay * (1 - SAFETY_MARGIN)))
  assert.equal(dailyBudgetFor(OPENROUTER, 1000), Math.floor(1000 * (1 - SAFETY_MARGIN)))
  assert.equal(dailyBudgetFor(OPENROUTER, null), dailyBudgetFor(OPENROUTER))
})

// Kills: a zero, negative or fractional override reaching the budget (a
// budget of 0 would refuse every message with a "used up" notice).
test('an override that is not a positive whole number is not used', () => {
  for (const bad of [0, -5, 1.5, NaN, '1000']) {
    assert.equal(dailyBudgetFor(OPENROUTER, bad), dailyBudgetFor(OPENROUTER), `override ${bad}`)
  }
})

// -- The switches in config.js ------------------------------------------

function configWith(overrides = {}) {
  const env = { ...process.env }
  delete env.CHAT_FAST_REPLIES
  delete env.CHAT_REASONING
  delete env.CHAT_REQUESTS_PER_DAY
  delete env.TELEGRAM_BOT_TOKEN
  delete env.TELEGRAM_CHAT_ID
  delete env.TELEGRAM_DISPATCHER_EMAIL
  env.DOTENV_CONFIG_PATH = join(root, '.env.does-not-exist')
  env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x'
  env.JWT_SECRET = 'x'.repeat(48)
  Object.assign(env, overrides)
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import c from './src/config.js'; process.stdout.write(JSON.stringify(c))"],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(out.trim())
}

function refused(overrides) {
  try {
    configWith(overrides)
  } catch (err) {
    return String(err.stderr)
  }
  return null
}

// Kills: fast on by default. It is a test-day switch.
test('fast replies are off unless the line says on', () => {
  assert.equal(configWith().chatFastReplies, false)
  assert.equal(configWith({ CHAT_FAST_REPLIES: '' }).chatFastReplies, false)
  assert.equal(configWith({ CHAT_FAST_REPLIES: 'off' }).chatFastReplies, false)
  assert.equal(configWith({ CHAT_FAST_REPLIES: ' On ' }).chatFastReplies, true)
})

// Kills: a typo ("yes", "true") silently meaning off on the test day.
test('CHAT_FAST_REPLIES other than on/off stops the app and names the key', () => {
  const err = refused({ CHAT_FAST_REPLIES: 'yes' })
  assert.ok(err, 'CHAT_FAST_REPLIES=yes started the app')
  assert.match(err, /CHAT_FAST_REPLIES/)
})

// Kills: the per-day number not reaching config, or a bad one accepted.
test('CHAT_REQUESTS_PER_DAY is a positive whole number or blank', () => {
  assert.equal(configWith().chatRequestsPerDay, null)
  assert.equal(configWith({ CHAT_REQUESTS_PER_DAY: '1000' }).chatRequestsPerDay, 1000)
  for (const bad of ['0', '-1', '1.5', 'lots']) {
    const err = refused({ CHAT_REQUESTS_PER_DAY: bad })
    assert.ok(err, `CHAT_REQUESTS_PER_DAY=${bad} started the app`)
    assert.match(err, /CHAT_REQUESTS_PER_DAY/)
  }
})

// Kills: a typo in CHAT_REASONING ("no", "false") silently leaving the
// thinking on -- the model would answer slowly and nobody would know why.
test('CHAT_REASONING other than on/off stops the app and names the key', () => {
  assert.equal(refused({ CHAT_REASONING: 'off' }), null)
  assert.equal(refused({ CHAT_REASONING: '' }), null)
  const err = refused({ CHAT_REASONING: 'no' })
  assert.ok(err, 'CHAT_REASONING=no started the app')
  assert.match(err, /CHAT_REASONING/)
})

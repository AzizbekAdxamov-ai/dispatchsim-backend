// What sendMessage promises its callers, and what it deliberately does not.
//
// The reply is written now and shown later. So sendMessage returns the
// dispatcher's own turn and a flag, and NOT the broker's answer -- the
// service says why in its own words: "Handing the caller a message it is
// not allowed to show yet is how a delay becomes a bug."
//
// scripts/chat-smoke.js destructured { brokerMessage } from it anyway. It
// had been broken since the delayed reply shipped, and nobody found out,
// because every run for weeks died one line earlier on the model call:
// first a retired model id, then a 404 with no reason attached, then a
// reasoning model with no room to answer. Three real bugs stacked in front
// of a fourth. The moment the third was fixed, the fourth surfaced as
// "Cannot read properties of undefined".
//
// This file is the check that would have found it without a working model.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = (p) => readFileSync(join(root, p), 'utf8')

const SERVICES = [
  ['src/modules/brokerChat/brokerChat.service.js', 'broker'],
  ['src/modules/driverChat/driverChat.service.js', 'driver'],
]

// Every file that could call the service directly. The frontend goes
// through HTTP and gets whatever the controller serialises, so the same
// rule reaches it through the controller.
function backendFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.js')) out.push(rel)
    }
  }
  walk('src')
  walk('scripts')
  return out
}

test('sendMessage returns the dispatcher turn and a flag, and nothing else', () => {
  for (const [file] of SERVICES) {
    const text = src(file)
    const returns = [...text.matchAll(/return \{ dispatcherMessage[^}]*\}/g)].map((m) => m[0])
    assert.equal(returns.length, 1, `${file}: sendMessage'ning qaytarish qatori topilmadi`)
    assert.equal(returns[0], 'return { dispatcherMessage, awaitingReply: true }',
      `${file}: qaytarish shakli o'zgargan`)
  }
})

test('no caller reads a reply off what sendMessage returns', () => {
  // The exact defect: `const { brokerMessage } = await service.sendMessage(...)`.
  // Any mention of these names outside the services themselves is either
  // that bug or a comment about it, so the check ignores comment lines
  // rather than pretending the words may never appear.
  const serviceFiles = new Set(SERVICES.map(([f]) => f))
  const offenders = []

  for (const file of backendFiles()) {
    if (serviceFiles.has(file)) continue
    const code = src(file)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    if (/\b(brokerMessage|driverMessage)\b/.test(code)) offenders.push(file)
  }

  assert.deepEqual(offenders, [],
    `bu fayllar yetkazilmagan javobni o'qimoqchi: ${offenders.join(', ')}`)
})

test('each service says out loud that it withholds the reply', () => {
  // A rule with no reason written next to it gets removed by the next
  // person who finds it inconvenient.
  for (const [file] of SERVICES) {
    const text = src(file)
    assert.match(text, /deliberately NOT returned|not allowed to show yet/,
      `${file}: javob nega qaytarilmasligi yozilmagan`)
  }
})

test('the smoke script reads the reply from where it actually is', () => {
  // It is allowed to look at a message the app would not show yet -- that
  // is the whole job of a smoke test. What it must not do is look in the
  // return value, where the reply has never been.
  const text = src('scripts/chat-smoke.js')
  assert.match(text, /FROM broker_messages/, 'javobni bazadan o\'qimayapti')
  assert.match(text, /deliver_at/, 'yetkazish vaqtini ko\'rsatmayapti')
  // And it says plainly that it is peeking, so nobody reads the output as
  // what a student would have seen.
  assert.match(text, /ilova buni .* soniyadan keyin ko'rsatadi|ko'rsatadi/,
    'kechikish tushuntirilmagan')
})

test('the smoke script notices a fallback reply instead of printing it as success', () => {
  // FALLBACK_REPLY is what the broker says when the model failed twice.
  // Printed without comment it looks exactly like a working chat.
  const text = src('scripts/chat-smoke.js')
  assert.match(text, /FALLBACK_REPLY/, 'zaxira javobni ajratmayapti')
  assert.match(text, /DIQQAT/, 'zaxira javob haqida ogohlantirmayapti')
})


test('each chat distinguishes explicit daily cap from provider throttle', () => {
  // Kills: mapping a temporary 429 to tomorrow, or describing a provider
  // throttle as a broker or driver who is unavailable.
  for (const [file, wrongCode] of [
    ['src/modules/brokerChat/brokerChat.service.js', 'CHAT_UNAVAILABLE'],
    ['src/modules/driverChat/driverChat.service.js', 'DRIVER_UNREACHABLE'],
  ]) {
    const text = src(file)
    assert.match(text, /if \(err\.quotaExhausted\)/, `${file}: kvota tugaganini ajratmayapti`)
    assert.match(text, /if \(err\.rateLimited\) throw new AppError\('CHAT_PROVIDER_BUSY'\)/)
    // And the quota branch comes FIRST, or the generic error swallows it.
    const quotaAt = text.indexOf('err.quotaExhausted')
    // Matched up to the code, not the closing paren: the driver's error
    // now carries its cause as details (2026-09-30), and what this test
    // guards is the ORDER of the two branches, not the argument list.
    const genericAt = text.indexOf(`throw new AppError('${wrongCode}'`)
    assert.ok(quotaAt > -1 && genericAt > quotaAt,
      `${file}: umumiy xato kvota tekshiruvidan oldin turibdi`)
    const busyAt = text.indexOf("if (err.rateLimited) throw new AppError('CHAT_PROVIDER_BUSY')")
    assert.ok(busyAt > quotaAt && busyAt < genericAt)
  }
})

test('provider daily-cap classification needs explicit evidence', () => {
  // A final ambiguous 429 or long Retry-After cannot prove a daily cap.
  const client = src('scripts/seed/aiClient.js')
  assert.match(client, /response\.status === 429 && isDailyCap\(why\)/)
  assert.match(client, /err\.rateLimited = true/)
})

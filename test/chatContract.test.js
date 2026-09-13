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


test('a provider 429 is reported as a budget, not as an unreachable person', () => {
  // aiClient marks an exhausted 429. If the services did not read that
  // mark, a student would be told the driver cannot be reached -- a
  // sentence about a person who is standing right there, while the real
  // problem is an account with no requests left and a different answer.
  //
  // This is the most likely failure with broker and driver on separate
  // keys: OpenRouter states it governs capacity per user across accounts
  // and keys, so the provider can stop answering while the app still
  // believes it has two budgets. When the two disagree, the provider wins.
  for (const [file, wrongCode] of [
    ['src/modules/brokerChat/brokerChat.service.js', 'CHAT_UNAVAILABLE'],
    ['src/modules/driverChat/driverChat.service.js', 'DRIVER_UNREACHABLE'],
  ]) {
    const text = src(file)
    assert.match(text, /if \(err\.quotaExhausted\)/, `${file}: kvota tugaganini ajratmayapti`)
    // And the quota branch comes FIRST, or the generic error swallows it.
    const quotaAt = text.indexOf('err.quotaExhausted')
    const genericAt = text.indexOf(`throw new AppError('${wrongCode}')`)
    assert.ok(quotaAt > -1 && genericAt > quotaAt,
      `${file}: umumiy xato kvota tekshiruvidan oldin turibdi`)
  }
})

test('every exhausted 429 is marked, not only the ones with a long retry-after', () => {
  // The mark used to depend on the provider sending a retry-after longer
  // than the backoff ladder. A provider that just says 429 and nothing
  // else would have fallen through to the generic error.
  const client = src('scripts/seed/aiClient.js')
  assert.match(client, /if \(response\.status === 429\) \{\s*\n\s*err\.quotaExhausted = true/,
    "retry-after'siz 429 belgilanmayapti")
})

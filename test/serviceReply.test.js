// The --service path of chat:eval and chat:scenarios: the live service's
// "check, regenerate once, fall back" with the model calls injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { serviceReply } from '../scripts/serviceReply.js'
import { brokerReplyProblem, brokerRetryPrompt } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem, driverRetryPrompt } from '../src/modules/driverChat/replyProblem.js'
import { cannotMakeLine } from '../src/lib/cannotMake.js'

const GOOD = 'Sure, I can do that.'
const WRONG = 'I need a word.'

// A problem function: WRONG is a content problem, BAD is unusable.
const problemOf = (reply) => {
  if (reply === 'BAD') return { why: 'was unusable', hint: '', unusable: true }
  if (reply === WRONG) return { why: 'was wrong', hint: ' Fix it.', unusable: false }
  return null
}
const retryPrompt = (sys, p) => `${sys} // ${p.why}${p.hint}`

function run(replies) {
  const calls = []
  const next = (tag) => async (arg) => { calls.push([tag, arg]); return replies.shift() }
  return {
    calls,
    go: () => serviceReply({ first: next('first'), again: next('again'), problemOf, retryPrompt, fallback: 'FALLBACK', systemPrompt: 'SYS' }),
  }
}

// Kills: --service spending a second request on a reply that was fine, so a
// run cost twice what the live app spends.
test('serviceReply: a clean reply is one call and unchanged', async () => {
  const r = run([GOOD])
  const out = await r.go()
  assert.equal(r.calls.length, 1)
  assert.deepEqual(out, { raw: GOOD, reply: GOOD, regeneratedBecause: null, fellBack: false, stillFailing: null })
})

// Kills: the regeneration not being asked with the problem's retry prompt,
// or the final reply being the first one.
test('serviceReply: a content problem regenerates once with the retry prompt', async () => {
  const r = run([WRONG, GOOD])
  const out = await r.go()
  assert.equal(r.calls.length, 2)
  assert.equal(r.calls[1][1], 'SYS // was wrong Fix it.')
  assert.equal(out.raw, WRONG)
  assert.equal(out.reply, GOOD)
  assert.equal(out.regeneratedBecause, 'was wrong')
  assert.equal(out.stillFailing, null)
})

// Kills: an unusable reply (banned word, too long) being shown after the
// retry also fails, instead of the holding line the live app shows.
test('serviceReply: unusable twice falls back', async () => {
  const r = run(['BAD', 'BAD'])
  const out = await r.go()
  assert.equal(r.calls.length, 2)
  assert.equal(out.reply, 'FALLBACK')
  assert.equal(out.fellBack, true)
  assert.equal(out.raw, 'BAD')
})

// Kills: a content problem that survives the retry being hidden (or looping
// for a third request) -- it is kept and named so the run can count it.
test('serviceReply: a content problem after the retry is kept and named', async () => {
  const r = run([WRONG, WRONG])
  const out = await r.go()
  assert.equal(r.calls.length, 2)
  assert.equal(out.reply, WRONG)
  assert.equal(out.fellBack, false)
  assert.equal(out.stillFailing, 'was wrong')
})

// Kills: the real shared checks not being what drives it (a pure test with
// the live broker functions: a too-long reply is unusable).
test('serviceReply works with the shared broker functions', async () => {
  const long = 'x'.repeat(2000)
  const replies = [long, 'Fine, what time?']
  const out = await serviceReply({
    first: async () => replies.shift(),
    again: async () => replies.shift(),
    problemOf: (r) => brokerReplyProblem(r, {}),
    retryPrompt: brokerRetryPrompt,
    fallback: 'FALLBACK',
    systemPrompt: 'SYS',
  })
  assert.equal(out.reply, 'Fine, what time?')
  assert.match(out.regeneratedBecause, /characters/)
})

// Kills: a second copy of the checks in the scripts (they would drift from
// the live service): both scripts must import the shared functions.
test('chat-eval and chat-scenarios use the shared reply checks', () => {
  for (const file of ['chat-eval.js', 'chat-scenarios.js']) {
    const src = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8')
    assert.match(src, /brokerReplyProblem/, file)
    assert.match(src, /driverReplyProblem/, file)
    assert.match(src, /serviceReply/, file)
  }
})

// Kills: chat-eval omitting booking facts from its --service check while the
// live broker chat and scenarios both reject premature booking promises.
test('chat-eval passes the same booking verdict to prompt and reply check', () => {
  const src = readFileSync(new URL('../scripts/chat-eval.js', import.meta.url), 'utf8')
  assert.match(src, /const booking = bookingFacts\(\{ texts: \[line\], carrier, posting, now \}\)/)
  assert.match(src, /said: \[line\],\s+booking,/)
  assert.match(src, /brokerReplyProblem\(r, \{ truck, booking, posting, now, text: line \}\)/)
})

// Kills: an unreachable pickup whose reply never says so (or states 1,200
// miles for 2,517) surviving the retry: the driver must end on the computed line.
test('serviceReply: an unreachable pickup ends on the computed cannot-make line', async () => {
  const offer = {
    city: 'Pittsburgh', miles: 2517, makesIt: false,
    pickupAt: new Date('2026-10-20T13:00:00Z'), earliestAt: new Date('2026-10-23T18:30:00Z'),
  }
  for (const second of ['Copy that. Need the address.', "Can't make it, about 1,200 miles out."]) {
    const replies = ["Copy that. Need pickup address, miles and drop details.", second]
    const out = await serviceReply({
      first: async () => replies.shift(),
      again: async () => replies.shift(),
      problemOf: (r) => driverReplyProblem(r, { offer }),
      retryPrompt: driverRetryPrompt,
      fallback: 'FALLBACK',
      systemPrompt: 'SYS',
    })
    assert.equal(out.reply, cannotMakeLine(offer))
    assert.equal(out.fellBack, true)
  }
})

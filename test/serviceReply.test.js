// The --service path of chat:eval and chat:scenarios: the live service's
// "check, regenerate once, fall back" with the model calls injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { serviceReply } from '../scripts/serviceReply.js'
import { brokerReplyProblem, brokerRetryPrompt } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem, driverRetryPrompt } from '../src/modules/driverChat/replyProblem.js'
import { cannotMakeLine } from '../src/lib/cannotMake.js'
import { brokerEvalContext } from '../scripts/brokerEvalContext.js'

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
  assert.match(src, /brokerEvalContext\(\{ posting, carrier, text: line, now \}\)/)
  assert.match(src, /brokerReplyProblem\(r, checkFacts\)/)
  const posting = { originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL',
    equipmentType: 'dry-van', rateUsd: 3000, distanceMi: 970, pickupAt: '2026-10-30T12:00:00Z', deliveryAt: '2026-11-01T12:00:00Z' }
  for (const [text, expected] of [['Hello', null], ['My MC is 741309', 'match'], ['My MC is 999999', 'mismatch']]) {
    const context = brokerEvalContext({ posting, carrier: { name: 'Example Freight', mcNumber: 'MC-741309' }, text,
      now: new Date('2026-10-28T12:00:00Z') })
    const reference = JSON.parse(context.history[0].content.split('\n').slice(1).join('\n'))
    assert.equal(reference.caller.mc.verdict, expected)
    assert.equal(context.checkFacts.booking.mc.verdict, expected)
    assert.deepEqual(reference.caller.mc, context.checkFacts.booking.mc)
    assert.equal(context.checkFacts.negotiation, context.negotiation)
  }
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

// -- Live broker checks end on a safe line, not on the reply -----------------------

import { PAYMENT_TERMS_LINE } from '../src/modules/brokerChat/termsTalk.js'
import { weightHoldLine } from '../src/modules/brokerChat/weightTalk.js'
import { NO_BOOKING_LINE } from '../src/modules/brokerChat/bookingTalk.js'
import { holdRateLine } from '../src/modules/brokerChat/rateTalk.js'

const LANE = {
  id: 'p1', originCity: 'Dallas', destinationCity: 'Chicago', originState: 'TX', destinationState: 'IL', equipmentType: 'dry-van',
  rateUsd: 2000, distanceMi: 1000, weightLbs: 30000, pickupAt: '2026-10-21T14:00:00Z',
}
const WHEN = new Date('2026-10-18T12:00:00Z')

// What the live service passes when the same bad reply comes twice.
async function twice(bad, text, extra = {}) {
  const replies = [bad, bad]
  return serviceReply({
    first: async () => replies.shift(),
    again: async () => replies.shift(),
    problemOf: (r) => brokerReplyProblem(r, { posting: LANE, now: WHEN, text, ...extra }),
    retryPrompt: brokerRetryPrompt,
    fallback: 'FALLBACK',
    systemPrompt: 'SYS',
  })
}

// Kills: any of the four new checks not reaching the end of the service path
// (returning no safeReply, or being content-only): the second bad reply must
// be replaced by the broker's own line, never shown and never the generic hold.
test('serviceReply: payment terms, weight, a phantom booking and an unexplained raise each end on their own line', async () => {
  const cases = [
    ["Yeah we do quick pay... the fee's just our standard accounting charge.", 'do you do quick pay?', PAYMENT_TERMS_LINE],
    ["Extra weight isn't an issue.", 'can u add 10k lbs more', weightHoldLine(LANE)],
    ["Good to hear, you're locked in with Mike.", 'i already booked this with ur guy mike', NO_BOOKING_LINE],
    ['I can do $2,300 on this one.', 'need $2,600', holdRateLine(LANE)],
  ]
  for (const [bad, text, line] of cases) {
    const out = await twice(bad, text)
    assert.equal(out.reply, line, bad)
    assert.equal(out.fellBack, true, bad)
    assert.notEqual(out.reply, 'FALLBACK', bad)
  }
})

// Kills: a safe line that the shared check itself flags: it would be thrown
// away on the next turn and the generic holding line shown instead.
test('every broker safe line passes the full brokerReplyProblem', () => {
  const pairs = [
    [PAYMENT_TERMS_LINE, 'do you do quick pay?'],
    [weightHoldLine(LANE), 'can u add 10k lbs more'],
    [NO_BOOKING_LINE, 'i already booked this with ur guy mike'],
    [holdRateLine(LANE), 'need $2,600'],
  ]
  for (const [line, text] of pairs) {
    assert.equal(brokerReplyProblem(line, { posting: LANE, now: WHEN, text, booking: null }), null, line)
  }
})

// Kills: a safe line that is flagged when the dispatcher's text claims an
// earlier booking, pushes the weight and names payment days all at once --
// the retry would judge it by the same facts and throw it away.
test('every broker safe line passes the full check when the text claims a booking too', () => {
  const text = 'i already booked this with ur guy mike, can u add 10k lbs more, need $2,600 and net 30'
  for (const line of [PAYMENT_TERMS_LINE, weightHoldLine(LANE), NO_BOOKING_LINE, holdRateLine(LANE)]) {
    assert.equal(brokerReplyProblem(line, { posting: LANE, now: WHEN, text, said: [text], booking: null }), null, line)
  }
})

// Kills: a service that stops giving brokerReplyProblem the same facts for
// the first reply and the regenerated one (brokerSaid / bookedHere dropped
// from one call), so the retry is judged by weaker rules than the first reply.
test('the live service passes one checkFacts to both brokerReplyProblem calls', () => {
  const src = readFileSync(new URL('../src/modules/brokerChat/brokerChat.service.js', import.meta.url), 'utf8')
  assert.equal(src.match(/brokerReplyProblem\(reply, checkFacts\)/g).length, 2)
  assert.match(src, /const brokerSaid = brokerTexts\(thread\)/)
  assert.match(src, /const checkFacts = \{[^}]*\bbrokerSaid,[^}]*bookedHere: BOOKED_STATUSES\.includes\(conversation\.status\)/)
  assert.match(src, /BOOKED_STATUSES = Object\.freeze\(\['agreed', 'booked'\]\)/)
  const scenarios = readFileSync(new URL('../scripts/chat-scenarios.js', import.meta.url), 'utf8')
  // The scenario runner builds the same checkFacts through the shared turn context.
  assert.match(scenarios, /const brokerSaid = history\.filter/)
  assert.match(scenarios, /problemOf: \(r\) => brokerReplyProblem\(r, ctx\.checkFacts\)/)
  const evalContext = readFileSync(new URL('../scripts/brokerEvalContext.js', import.meta.url), 'utf8')
  assert.match(evalContext, /checkFacts: \{\s+truck, booking, posting, now, text, said, brokerSaid,/)
  // The prompt gets it too: the MC question depends on what the broker already asked.
  assert.match(src, /booking,\s+brokerSaid,\s+negotiation: decision,\s+\}\)/)
  assert.match(evalContext, /posting, carrier, now, thread, said, paper, booking, brokerSaid, negotiation,/)
})

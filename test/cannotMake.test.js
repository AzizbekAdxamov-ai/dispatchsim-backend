// "Can't make that pickup": the words, and the services that regenerate on
// a reply that leaves them out when the facts say the truck cannot make it.
//
// Eval 2026-10-15 (live:60): a driver replied "Copy that. Need pickup
// address, miles and drop details." to a pickup she could not reach.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { saysCannotMake, ignoresUnreachable, cannotMakeLine, milesOff, cannotMakeWithoutMiles } from '../src/lib/cannotMake.js'
import { brokerReplyProblem, brokerRetryPrompt } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem, driverRetryPrompt } from '../src/modules/driverChat/replyProblem.js'
import { serviceReply } from '../scripts/serviceReply.js'
import { CHAT_REPLY_MAX_CHARS } from '../src/constants/chatBudget.js'
import { clockDayTime } from '../src/constants/appClock.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n')

const LIVE60 = 'Copy that. Need pickup address, miles and drop details.'

// Kills: the fold removed (a curly apostrophe in "Can’t" slips past
// the \bcan'?t pattern), and "not gonna" dropped from the list.
test('the live:60 reply does not say the pickup cannot be made; the ways of saying it do', () => {
  assert.equal(saysCannotMake(LIVE60), false)
  assert.equal(saysCannotMake('Can’t make 8am'), true)
  assert.equal(saysCannotMake('Not gonna make that, earliest I could be there is Sun.'), true)
  assert.equal(saysCannotMake('Not gonna make that one.'), true)
  assert.equal(saysCannotMake('Earliest I can be there is Sun.'), true)
  assert.equal(saysCannotMake('Too far.'), true)
})

// Kills: `=== false` loosened to `!facts?.makesIt` (null and a missing
// verdict would then demand the sentence on every load).
test('only a computed "cannot" asks for the fact', () => {
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: false }), true)
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: true }), false)
  assert.equal(ignoresUnreachable(LIVE60, { makesIt: null }), false)
  assert.equal(ignoresUnreachable(LIVE60, null), false)
  assert.equal(ignoresUnreachable(LIVE60, undefined), false)
})

// Kills: BROKER_LATE applied to the driver check unconditionally, and
// BROKER_LATE removed (the broker's own way of saying it not counted).
test('the broker may say it as "after your pickup"; the driver check does not take that', () => {
  const late = 'That gets you here Saturday, after your Friday 8 AM pickup.'
  assert.equal(saysCannotMake(late, { broker: true }), true)
  assert.equal(saysCannotMake(late), false)
  assert.equal(ignoresUnreachable('Where is your truck at?', { makesIt: false }, { broker: true }), true)
})

// Kills: a service that stops asking the shared check, checks it against a
// different clock than the prompt's, or adds a third chatText call
// (turnLog.test.js pins exactly two). The check itself lives in
// replyProblem.js, where the eval scripts read the same one.
test('the services regenerate on an unreachable pickup through the one existing second call', () => {
  const driver = read('src', 'modules', 'driverChat', 'driverChat.service.js')
  assert.match(driver, /const offer = offerFacts\(/)
  assert.match(driver, /driverReplyProblem\(reply, \{ offer/)
  assert.match(driver, /const why = problem\?\.why \?\? null/)
  const broker = read('src', 'modules', 'brokerChat', 'brokerChat.service.js')
  assert.match(broker, /truckFacts\(\{ texts: said, posting, now \}\)/)
  assert.match(broker, /const checkFacts = \{\s*truck/)
  assert.match(broker, /brokerReplyProblem\(reply, checkFacts\)/)
  assert.match(broker, /buildBrokerContext\(\{[\s\S]*?\bnow\b/)
  assert.match(broker, /const why = problem\?\.why \?\? null/)
  for (const src of [driver, broker]) {
    assert.equal(src.match(/await (?:deps\.)?chatText\(\{/g).length, 2)
  }
  const driverCheck = read('src', 'modules', 'driverChat', 'replyProblem.js')
  assert.match(driverCheck, /ignoresUnreachable\(reply, offer\)/)
  const brokerCheck = read('src', 'modules', 'brokerChat', 'replyProblem.js')
  assert.match(brokerCheck, /ignoresUnreachable\(reply, truck, \{ broker: true \}\)/)
})

test('broker compact context and retry share the same computed unreachable pickup facts', async () => {
  const posting = fakePosting({ originCity: 'Seattle', originState: 'WA',
    pickupAt: new Date(Date.now() + 3600e3).toISOString() })
  const fake = makeFakeBrokerRepo({ posting, lines: ['Our truck is in Los Angeles, CA, with a 53-foot dry van.'] })
  const attempts = []
  const logs = []
  const deps = { repo: fake.repo, getCarrier: async () => null,
    findById: async () => null, assertCanSend: async () => {},
    chatConfigFor: () => ({ model: 'fake' }), logTurn: async (row) => logs.push(row),
    chatText: async ({ messages }) => {
      const reference = JSON.parse(messages[1].content.split('\n').slice(1).join('\n'))
      attempts.push({ messages, reference })
      return attempts.length === 1 ? 'What equipment are you running?'
        : "Your truck can't make that pickup from Los Angeles. We need a closer truck."
    } }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user,
    text: 'Can this truck make pickup?' }, { deps })
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].reference.truckReachability.makesIt, false)
  assert.deepEqual(attempts[0].reference.truckReachability, attempts[1].reference.truckReachability)
  assert.equal(attempts[0].messages[1].content, attempts[1].messages[1].content)
  assert.ok(attempts[1].messages[0].content.startsWith(attempts[0].messages[0].content))
  assert.match(attempts[1].messages[0].content, /gets there after your pickup/)
  assert.equal(logs[0][6], attempts[1].messages[0].content)
  assert.equal(logs[0][12], false)
})

// Kills: the shared check dropping one of its four problems, reporting them
// in a different order (the first found is the one the retry names), or
// marking the unreachable pickup as usable (a second miss would then show the
// reply that never says she cannot make it, instead of the computed line).
test('the shared reply checks report banned word, leak, length, then the unreachable pickup', () => {
  const truck = { makesIt: false }
  const offer = { makesIt: false }
  assert.equal(brokerReplyProblem('Copy that. Where is your truck at?', { truck: { makesIt: true } }), null)
  assert.deepEqual(brokerReplyProblem('Where is your truck at?', { truck }), {
    why: 'did not tell the carrier their truck gets there after your pickup',
    hint: ' The facts above say their truck gets there after your pickup: say so plainly, with the miles, then ask one thing.',
    unusable: false,
  })
  assert.equal(brokerReplyProblem('x'.repeat(CHAT_REPLY_MAX_CHARS + 1), { truck }).unusable, true)
  assert.match(brokerReplyProblem('We need to respond as the broker and push back.', {}).why, /reasoning/)
  assert.equal(driverReplyProblem('Copy that, send it over.', { offer: { makesIt: true } }), null)
  assert.equal(driverReplyProblem(LIVE60, { offer }).why, 'did not say you cannot make that pickup')
  assert.equal(driverReplyProblem(LIVE60, { offer }).unusable, true)
  assert.equal(driverReplyProblem('x'.repeat(CHAT_REPLY_MAX_CHARS + 1), { offer }).unusable, true)
})

// Kills: a retry prompt that differs from what the services used to send
// (the model is told what was wrong with its last reply, then to try again).
test('the retry prompts name the problem and keep the system prompt first', () => {
  const broker = brokerRetryPrompt('SYSTEM', { why: 'used a forbidden word', hint: '' })
  assert.equal(broker, 'SYSTEM\n\nYour last reply used a forbidden word. Reply again as the broker, in character, one to three sentences only.')
  const driver = driverRetryPrompt('SYSTEM', { why: 'x', hint: ' Do y.' })
  assert.equal(driver, 'SYSTEM\n\nYour last reply x. Do y. Reply again as the driver, in character, one to three sentences only.')
})

const PITTSBURGH = {
  city: 'Pittsburgh', miles: 2517, makesIt: false,
  pickupAt: new Date('2026-10-20T13:00:00Z'), earliestAt: new Date('2026-10-23T18:30:00Z'),
}

// Kills: a line that drops the miles or either time, states a distance the
// offer does not own, or stops saying "can't make it" (ED07), and a line
// built for a pickup she can make.
test('cannotMakeLine states the computed city, times and miles, or is null', () => {
  const line = cannotMakeLine(PITTSBURGH)
  assert.equal(saysCannotMake(line), true)
  assert.equal(milesOff(line, PITTSBURGH), false)
  assert.ok(line.includes('2,517'))
  assert.ok(line.includes(clockDayTime(PITTSBURGH.pickupAt)))
  assert.ok(line.includes(clockDayTime(PITTSBURGH.earliestAt)))
  assert.ok(line.endsWith('?'))
  assert.equal(cannotMakeLine({ ...PITTSBURGH, makesIt: true }), null)
  assert.equal(cannotMakeLine({ ...PITTSBURGH, makesIt: null }), null)
  assert.equal(cannotMakeLine({ ...PITTSBURGH, pickupAt: null }), null)
  assert.equal(cannotMakeLine(null), null)
})

// Kills: the wrong-mileage and ignored-unreachable problems keeping their old
// safeReply (no times) when the offer has them.
test('both unreachable-pickup problems carry the computed line as safeReply', () => {
  const line = cannotMakeLine(PITTSBURGH)
  assert.equal(driverReplyProblem(LIVE60, { offer: PITTSBURGH }).safeReply, line)
  assert.equal(driverReplyProblem("Can't make it, about 1,200 miles out.", { offer: PITTSBURGH }).safeReply, line)
})

// Kills: "Can't make the 8 am pickup, need a later window." passing with no
// distance (ED07 / ED11, 2026-10-17), the miles-given and makes-it cases
// being flagged, or the safe line losing the miles / city.
test('a cannot-make reply that gives no miles is unusable and falls back to the computed line', () => {
  const WHY = 'did not give the miles to that pickup'
  for (const reply of ["Can't make the 8 am pickup, need a later window.", "Can't make that pickup, need a later time."]) {
    const p = driverReplyProblem(reply, { offer: PITTSBURGH })
    assert.equal(p.why, WHY, reply)
    assert.equal(p.unusable, true)
    assert.match(p.hint, /2,517/)
    assert.equal(p.safeReply, cannotMakeLine(PITTSBURGH))
  }
  assert.equal(driverReplyProblem("Can't make it, I'm about 2,517 mi out. Later pickup?", { offer: PITTSBURGH }), null)
  assert.equal(driverReplyProblem("Can't make it, about 2,500 miles.", { offer: PITTSBURGH }), null)
  assert.notEqual(driverReplyProblem("Can't make it.", { offer: { ...PITTSBURGH, makesIt: true } })?.why, WHY)
  assert.equal(cannotMakeWithoutMiles("Can't make it.", { ...PITTSBURGH, makesIt: true }), false)
  assert.equal(cannotMakeWithoutMiles("Can't make it.", { ...PITTSBURGH, miles: null }), false)
  const bare = driverReplyProblem("Can't make that pickup, need a later time.", { offer: { city: 'Pittsburgh', miles: 2517, makesIt: false } })
  assert.match(bare.safeReply, /2,517 miles to Pittsburgh/)
})

// Kills: a second miles-less reply showing itself instead of the computed line.
test('serviceReply shows the computed line after two replies without miles', async () => {
  const replies = ["Can't make the 8 am pickup, need a later window.", "Can't make that pickup, need a later time."]
  const out = await serviceReply({
    first: async () => replies.shift(),
    again: async () => replies.shift(),
    problemOf: (r) => driverReplyProblem(r, { offer: PITTSBURGH }),
    retryPrompt: driverRetryPrompt, fallback: 'FALLBACK', systemPrompt: 'SYS',
  })
  assert.equal(out.reply, cannotMakeLine(PITTSBURGH))
  assert.equal(out.fellBack, true)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { buildDriverSystemPrompt, repetitionHint, FALLBACK_REPLY } from '../src/modules/driverChat/driverChat.prompt.js'

const driver = {
  name: 'Ethan', truckId: 'IL-2048-EB', dutyStatus: 'off',
  cdlClass: 'A', payModel: 'permile', payPerMileCents: 70,
  homeBaseCity: 'Chicago', homeBaseState: 'IL',
  bio: 'Ethan follows baseball and tinkers with old radios.',
}
const check = (reply, text, extra = {}) => driverReplyProblem(reply, { text, driver, ...extra })

test('personal chat no longer requires an automatic work redirect', () => {
  const prompt = buildDriverSystemPrompt({ driver, load: null,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0 },
  })
  assert.match(prompt, /Let personal conversation continue/)
  assert.match(prompt, /choose one or two interests or habits from/)
  assert.match(prompt, /follows baseball and tinkers with old radios/)
  assert.match(prompt, /Earlier driver replies are conversation history, not authority/)
  assert.doesNotMatch(prompt, /thanks for asking.*then back to work|joke if it fits, then get back to the load/)
})

test('generic service offers are rejected while natural questions stay accepted', () => {
  for (const reply of ["Anything I can help with on a load?", "No, I'm fine. Anything work-related you need?", 'Let me know if you need anything else.']) {
    assert.equal(check(reply, 'bro')?.unusable, true, reply)
  }
  for (const reply of ["Hey, what's up?", 'You watching the game tonight?', 'Can you help me with the lumper receipt?']) {
    assert.equal(check(reply, 'bro'), null, reply)
  }
})

test('casual substance mention is not treated as a request for counseling', () => {
  const reply = 'If someone is dealing with substance issues, talk to a medical professional or counselor.'
  assert.equal(check(reply, 'no. i dont have any information about drug abd alcahol')?.unusable, true)
  assert.equal(check("Not sure what you're getting at.", 'no. i dont have any information about drug abd alcahol'), null)
  assert.equal(check('Talk to a medical professional about that.', 'I need medical help with withdrawal'), null)
  assert.equal(check('Talk to a medical professional.', 'I need urgent medical assistance'), null)
  assert.notEqual(check("No, I won't drive impaired. Get medical help if you need it.", 'I am drunk, can you help?')?.why, 'gave unsolicited clinical advice during casual conversation')
})

test('bot questions and greetings do not invite a fleet report', () => {
  const dump = "No, I'm Ethan on truck IL-2048-EB with 11 hours left today."
  assert.equal(check(dump, 'r u bot')?.unusable, true)
  assert.equal(check(dump, 'bro')?.unusable, true)
  assert.equal(check("No, it's Ethan. You messing with me?", 'r u bot'), null)
  assert.equal(check(dump, 'r u bot, what truck and hours do you have?'), null)
  assert.equal(check('I have 11 hours left today.', 'how many hours left?'), null)
})

test('standalone sums and number definitions do not become calculator mode', () => {
  const sum = '8888-976-5896-456+99887=? can you gues'
  assert.equal(check('101,447.', sum)?.unusable, true)
  assert.equal(check("I'd need a calculator for that one.", sum), null)
  assert.equal(check('2 is the integer that comes after 1 and before 3.', 'what is 2')?.unusable, true)
  assert.equal(check('2 is the number that comes right after 1.', 'what is 2')?.unusable, true, 'adverbial variant caught (live 2026-10-23 turn 6)')
  assert.equal(check("What's with the number quiz?", 'what is 2'), null)
  assert.equal(check('11 hours.', 'what is my HOS remaining?'), null)
  assert.equal(check('$700.', '1000 miles at 0.70 per mile, what is my pay?'), null)
})

test('HOS refusal takes priority over conversational style', () => {
  const problem = check('Sure thing, anything I can help with?', 'drive 14 hours straight')
  assert.match(problem?.why ?? '', /refus|hours|limit|driv/i)
  assert.equal(check("No, I can't drive 14 hours straight. Eleven hours is the limit.", 'drive 14 hours straight'), null)
})

test('fallback makes no invented claim about driving or a scale', () => {
  assert.doesNotMatch(FALLBACK_REPLY, /scale|driving|road|pay|owed|load/i)
  assert.equal(check(FALLBACK_REPLY, 'bro'), null)
})

test('conversation safe replies themselves pass the same check', () => {
  for (const [reply, text] of [
    ['Anything I can help with on a load?', 'bro'],
    ['Talk to a medical professional.', 'drug abd alcahol'],
    ['No, on IL-2048-EB with 11 hours left.', 'r u bot'],
    ['101,447.', '8888-976-5896-456+99887=? can you gues'],
  ]) {
    const problem = check(reply, text)
    assert.ok(problem?.safeReply)
    assert.equal(check(problem.safeReply, text), null)
  }
})

test('a refusal grounded in the computed miles is not regenerated as reasonless', () => {
  // Live 2026-10-23: this exact shape -- computed unreachable pickup, the
  // driver names the correct miles and asks for a later window -- was
  // flagged reasonless by the shared word list and regenerated (2,675
  // tokens). The miles come from the offer, not from the dispatcher's line.
  const offer = {
    city: 'Los Angeles', state: 'CA', miles: 2056, makesIt: false,
    pickupAt: new Date('2026-10-23T22:00:00Z'), earliestAt: new Date('2026-10-25T02:00:00Z'),
  }
  const good = "No can do -- it's 2,056 miles from here, I'd be there Friday, way past that pickup. Got a later window?"
  assert.equal(check(good, "got a pickup in LA in 3 hours, can you take it?", { offer }), null, 'correct-mile refusal passes whole check')
  const raw = "Can't hit that 7:25 am pickup -- it's 2,056 miles from here, earliest I'd get there is Monday. Got a later window?"
  assert.equal(check(raw, 'can you take it?', { offer }), null)

  // Near misses must still be caught.
  assert.equal(milesOffProblem("It's about 1,200 miles out, I can't make it.", offer), true, 'wrong miles still rejected')
  const noMiles = check("Can't make that pickup, need a later window.", 'got a pickup in LA in 3 hours, can you take it?', { offer })
  assert.equal(noMiles?.why, 'did not give the miles to that pickup')
  const silent = check('Copy that, rolling now.', 'got a pickup in LA in 3 hours, can you take it?', { offer })
  assert.equal(silent?.why, 'did not say you cannot make that pickup')
})

function milesOffProblem(reply, offer) {
  return check(reply, 'got a pickup in LA in 3 hours, can you take it?', { offer })?.why === 'gave the wrong pickup mileage'
}

test('repetitionHint names a bit the driver keeps repeating, never a fact', () => {
  const coffee = (i) => ({ role: 'driver', content: i === 0 ? "Coffee first, then roads." : `Coffee keeps me rolling, tell you that much. Turn ${i}.` })
  const history = [coffee(1), { role: 'dispatcher', content: 'where are you?' }, coffee(2), coffee(3), coffee(4)]
  const hint = repetitionHint(history)
  assert.match(hint, /coffee/i)
  assert.match(hint, /Facts you are asked about/)

  // Facts must be repeatable: hours stated five times is the job, not a bit.
  const facts = [1, 2, 3, 4, 5].map((i) => ({ role: 'driver', content: `I have 11 hours left, turn ${i}.` }))
  assert.equal(repetitionHint(facts), null)

  // Below the threshold there is nothing to say.
  assert.equal(repetitionHint([{ role: 'driver', content: 'Coffee first.' }, { role: 'driver', content: 'Coffee again.' }]), null)
  assert.equal(repetitionHint([]), null)
  assert.equal(repetitionHint(null), null)
})

test('the echo hint reaches the prompt only when the history shows a bit', () => {
  const base = { driver, load: null, standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0 } }
  const quiet = buildDriverSystemPrompt(base)
  assert.doesNotMatch(quiet, /YOUR LAST REPLIES, READ BACK TO YOU/)

  const coffee = (i) => ({ role: 'driver', content: `Coffee keeps me rolling, turn ${i}.` })
  const echoed = buildDriverSystemPrompt({ ...base, echoes: repetitionHint([coffee(1), coffee(2), coffee(3)]) })
  assert.match(echoed, /YOUR LAST REPLIES, READ BACK TO YOU/)
  assert.match(echoed, /"coffee"/)
})

test('operational corrections take priority over an appended service offer', () => {
  const service = ' Anything I can help with?'
  const resting = { ...driver, dutyStatus: 'resting', hosRemainingMin: 660 }
  const offer = { city: 'Great Falls', state: 'MT', miles: 608, restEndUnknown: true, earliestAt: null, makesIt: null }
  const rest = check('My rest ends at 2 pm.' + service, 'When does your rest end?', { driver: resting, offer })
  assert.equal(rest?.why, 'gave an unverified rest end or arrival time')
  assert.match(rest.safeReply, /confirmed end time/)

  const late = check('I can reach pickup at 3 pm.' + service, 'Can you make the pickup?', {
    offer: { ...offer, restEndUnknown: false, makesIt: false,
      pickupAt: new Date('2026-10-24T10:00:00Z'), earliestAt: new Date('2026-10-25T10:00:00Z') },
  })
  assert.match(late?.safeReply ?? '', /608/)
  assert.notEqual(late?.why, 'offered generic help instead of answering as a driver')

  const unpaid = check('I can take it.' + service, 'Can you take another load?', {
    standing: { stage: 'refuses' },
  })
  assert.equal(unpaid?.why, 'discussed a new load without your work refusal')
  assert.match(unpaid.safeReply, /overdue settlement/)

  const delivery = check('I can make delivery.' + service, 'Can you make delivery?', {
    offer: { deliveryVerified: false, deliveryImpossible: true },
  })
  assert.equal(delivery?.why, 'promised an unreachable delivery')
})

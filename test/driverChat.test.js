// The driver persona, and the one rule that must not live in it.
//
// The refusal is enforced by dispatchLoad against driver_settlements. This
// prompt only makes the character consistent with a decision the database
// has already made. These tests guard the seam: every stage the payroll
// rules can produce must have something to say, and the prompt must be
// told the numbers rather than left to invent them.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDriverSystemPrompt, buildMessages, trippedBannedWord,
  leaksReasoning, FALLBACK_REPLY, STANCE_STAGES,
} from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyDelaySec, DRIVER_REPLY_SEC } from '../src/modules/driverChat/driverChat.replyTiming.js'
import { stageFor, DRIVER_STAGES } from '../src/constants/driverPay.js'
import { GET_DRIVER_CONTEXT_SQL } from '../src/modules/driverChat/driverChat.sql.js'
import { seeded } from './helpers/rng.js'

const DRIVER = {
  id: 'd1', name: 'Marcus Webb', cdlClass: 'A',
  homeBaseCity: 'Amarillo', homeBaseState: 'TX',
  dutyStatus: 'resting', payModel: 'percent', payPercentBp: 2700,
  payPerMileCents: null, truckId: 't1042',
}

function standing(daysOverdue, owedUsd = 1840, unpaidCount = 3) {
  return {
    stage: stageFor(daysOverdue), daysOverdue, owedUsd, unpaidCount,
  }
}

test('every stage the payroll rules produce has a stance to speak from', () => {
  // A stage with no entry would fall through to 'ok' -- a driver owed
  // three weeks of pay chatting cheerfully about the weather. This asserts
  // the two files agree, so adding a stage to driverPay.js without adding
  // its stance here fails here rather than in front of a student.
  const produced = new Set(
    [null, -1, 0, 3, DRIVER_STAGES.refuses, DRIVER_STAGES.quits, 999].map(stageFor),
  )
  for (const stage of produced) {
    assert.ok(STANCE_STAGES.includes(stage), `stance yo'q: ${stage}`)
  }
})

test('the prompt states the amount and the wait, and never leaves them vague', () => {
  const p = buildDriverSystemPrompt({ driver: DRIVER, standing: standing(9), load: null })
  assert.match(p, /\$1,840/)
  assert.match(p, /3 settlements/)
  assert.match(p, /9 days past due/)
  // A person knows their own number. If the prompt did not carry it, the
  // model would invent one, and the dispatcher would be told a figure that
  // does not match the Settlements page.
  assert.ok(!/some money|an amount|unpaid wages/i.test(p))
})

test('a paid-up driver is not handed a grievance to perform', () => {
  const p = buildDriverSystemPrompt({
    driver: DRIVER,
    standing: { stage: 'ok', daysOverdue: null, owedUsd: 0, unpaidCount: 0 },
    load: null,
  })
  assert.match(p, /Nothing outstanding/)
  assert.match(p, /do not bring it up/i)
  assert.ok(!/not taking another load/i.test(p))
})

test('a refusing driver is firm and specific, and never abusive', () => {
  const p = buildDriverSystemPrompt({ driver: DRIVER, standing: standing(9), load: null })
  assert.match(p, /not taking another load until it is settled/i)
  assert.match(p, /No insults, no threats, no swearing/i)
  // Being owed money is not licence to be cruel, and a simulator that
  // taught otherwise would be teaching the wrong thing twice over.
  assert.match(p, /professional/i)
})

test('the driver is told what they cannot know', () => {
  const p = buildDriverSystemPrompt({ driver: DRIVER, standing: standing(2), load: null })
  // The company balance is the tempting one: a driver who could see it
  // would negotiate against numbers no real driver has.
  assert.match(p, /do NOT know the company bank balance/i)
  assert.match(p, /You do not decide whether a load gets assigned to you/i)
})

test('the load the driver is on reaches the prompt', () => {
  const load = {
    id: '4471', originCity: 'Atlanta', originState: 'GA',
    destinationCity: 'Denver', destinationState: 'CO', distanceMi: 1400,
  }
  const withLoad = buildDriverSystemPrompt({ driver: DRIVER, standing: standing(0), load })
  assert.match(withLoad, /load 4471/)
  assert.match(withLoad, /Atlanta, GA/)

  const without = buildDriverSystemPrompt({ driver: DRIVER, standing: standing(0), load: null })
  assert.match(without, /no load on you at the moment/i)
})

test('known truck trailer type reaches the prompt without inventing length', () => {
  assert.match(GET_DRIVER_CONTEXT_SQL, /t\.trailer_type AS "trailerType"/)
  const prompt = buildDriverSystemPrompt({
    driver: { ...DRIVER, trailerType: 'reefer' }, standing: standing(0), load: null,
  })
  assert.match(prompt, /truck record lists reefer as its trailer type/)
  assert.match(prompt, /Trailer length is not recorded/)
  assert.doesNotMatch(prompt, /48.ft|53.ft/)
})

test('missing trailer type or truck stays unknown', () => {
  const unknownType = buildDriverSystemPrompt({
    driver: { ...DRIVER, trailerType: null }, standing: standing(0), load: null,
  })
  assert.match(unknownType, /truck record does not list a trailer type/)
  assert.match(unknownType, /Trailer length is not recorded/)

  const noTruck = buildDriverSystemPrompt({
    driver: { ...DRIVER, truckId: null, trailerType: null }, standing: standing(0), load: null,
  })
  assert.match(noTruck, /no truck assigned right now/)
  assert.doesNotMatch(noTruck, /truck record lists|Trailer length is not recorded/)
})

test('verified trailer length reaches the driver independently of type', () => {
  assert.match(GET_DRIVER_CONTEXT_SQL, /t\.trailer_length_ft AS "trailerLengthFt"/)
  const prompt = buildDriverSystemPrompt({
    driver: { ...DRIVER, trailerType: 'dry-van', trailerLengthFt: 53 },
    standing: standing(0), load: null,
  })
  assert.match(prompt, /truck record lists dry van as its trailer type/)
  assert.match(prompt, /truck record lists a 53-foot trailer/)
  assert.doesNotMatch(prompt, /Trailer length is not recorded/)
})

test('driver rows are the assistant turn, dispatcher rows the user turn', () => {
  const msgs = buildMessages({
    systemPrompt: 'S',
    history: [
      { role: 'dispatcher', content: 'you around?' },
      { role: 'driver', content: 'yeah' },
    ],
    newMessage: 'got a load for you',
  })
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(msgs.at(-1).content, 'got a load for you')
})

test('assistant-speak and leaked reasoning are both caught', () => {
  assert.ok(trippedBannedWord('Certainly, I can help with that'))
  assert.ok(trippedBannedWord('As an AI, I cannot drive'))
  assert.equal(trippedBannedWord('Yeah I can take that one'), null)

  assert.ok(leaksReasoning('We need to respond as Marcus Webb, pushing back on pay'))
  assert.ok(leaksReasoning('<think>the dispatcher wants me to run'))
  assert.ok(!leaksReasoning('I need to get fuel before I roll'))
})

test('the fallback line takes no side on the money', () => {
  // A fallback that complained would put words in a paid-up driver's
  // mouth; one that agreed to drive would contradict a refusal the
  // database is enforcing. It says neither.
  assert.ok(!/pay|owed|money|settlement/i.test(FALLBACK_REPLY))
  assert.ok(!/sure|yes|on my way/i.test(FALLBACK_REPLY))
})

test('a driving driver answers slower than one in the bunk', () => {
  const N = 5000
  const avg = (st) => {
    const rng = seeded(5)
    let sum = 0
    for (let i = 0; i < N; i += 1) sum += driverReplyDelaySec(st, rng)
    return sum / N
  }
  assert.ok(avg('driving') > avg('on-duty'), 'wheel time should cost more than a fuel stop')
  assert.ok(DRIVER_REPLY_SEC.driving[0] > DRIVER_REPLY_SEC['on-duty'][0])
})

test('an unknown duty status still produces a usable delay', () => {
  // duty_status is CHECK-constrained today, but a delay of NaN seconds
  // would be an INSERT that fails on a message someone is waiting for.
  const rng = seeded(9)
  for (const st of ['nonsense', null, undefined, '']) {
    const d = driverReplyDelaySec(st, rng)
    assert.ok(Number.isInteger(d) && d > 0, `${st} -> ${d}`)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agreesRebroker, proposesRebroker, refusesRebroker, ONE_CARRIER_REPLY, ONE_CARRIER_RULE } from '../src/modules/brokerChat/carrierPolicy.js'
import { brokerReply } from '../scripts/scenarioChecks.js'
import { inventsEnvironment } from '../src/lib/environmentClaims.js'
import { latenessProblem, latenessStatus, latenessLine } from '../src/lib/lateness.js'
import { stopPayInvented } from '../src/modules/brokerChat/termsTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { brokerEvalContext } from '../scripts/brokerEvalContext.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'
import { BROKER_CASES, DRIVER_CASES } from '../scripts/evalCases.js'

test('direct, indirect and mixed refusal/permission rebroker replies share runtime findings', () => {
  for (const raw of ['Yes, rebroker it on your MC, no problem.', 'Use your own MC, that is okay.',
    'We never ship under another carrier. Put it on my other MC, that works.',
    'No rebrokering; but whoever hauls it is fine.', 'Put it under another carrier.',
    'We do not rebroker, yes, put it under another carrier.', 'No, go ahead and rebroker it on your MC.']) {
    assert.equal(agreesRebroker(raw), true, raw)
    assert.ok(brokerReply(raw, null).includes('agrees to re-broker'), raw)
  }
  for (const raw of ['No rebrokering, no matter who moves it.', 'We do not ship it under another carrier.', ONE_CARRIER_REPLY]) {
    assert.equal(agreesRebroker(raw), false, raw)
  }
})

test('active rebroker proposal takes precedence over mixed handshake and email', async () => {
  for (const text of ['Agreed. Send it to dispatch@example.com. I will rebroker this to another carrier.',
    'Can I hand the load to another carrier under my MC?', 'ill rebroker this on my own mc to another carrier, u still get ur rate']) {
    assert.equal(proposesRebroker(text), true)
    const fake = makeFakeBrokerRepo()
    let calls = 0
    await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text }, { deps: {
      repo: fake.repo, assertCanSend: async () => {}, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
      findById: async () => ({ email: 'dispatch@example.com' }), chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {},
      chatText: async () => { calls += 1; return 'Yes, rebroker it on your MC, no problem.' },
    } })
    assert.equal(calls, 2)
    assert.equal(fake.state.messages.filter((m) => m.role === 'broker').at(-1).content, ONE_CARRIER_REPLY)
    assert.equal(fake.state.conversation.agreedRateUsd, null)
    assert.equal(fake.state.conversation.recipientEmail, null)
    assert.equal(fake.state.messages.some((m) => m.kind === 'rate_con'), false)
  }
  assert.equal(proposesRebroker("I won't rebroker it; I'll use my own truck."), false)
  assert.equal(proposesRebroker('What is rebrokering?'), false)
  assert.equal(proposesRebroker('I do not have a truck, I will rebroker this on my MC to another carrier.'), true)
  assert.equal(proposesRebroker('I do not have a truck so I will rebroker this on my own MC.'), true)
  assert.equal(refusesRebroker('Not one carrier, multiple carriers can move it.'), false)
  assert.equal(brokerReplyProblem('Not one carrier, multiple carriers can move it.', { text: 'I will rebroker on my MC.' })?.unusable, true)
})

test('a rebroker proposal cannot replace prior agreed rate, recipient or paper', async () => {
  const fake = makeFakeBrokerRepo()
  Object.assign(fake.state.conversation, { status: 'agreed', agreedRateUsd: 3000, brokerOfferUsd: 3000,
    recipientEmail: 'original@example.com', negotiationStage: 'paper_pending', rateConRateUsd: 3000 })
  await fake.repo.addMessage(FAKE_IDS.conversation, 'broker', 'Existing paper.', { kind: 'rate_con', delaySec: 3600 })
  const snapshot = { ...fake.state.conversation }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user,
    text: 'Agreed. Send it to replacement@example.com. I will rebroker it to another carrier.' }, { deps: {
    repo: fake.repo, assertCanSend: async () => {}, getCarrier: async () => null,
    findById: async () => null, chatConfigFor: () => ({ model: 'fake' }), logTurn: async () => {}, chatText: async () => ONE_CARRIER_REPLY,
  } })
  for (const key of ['agreedRateUsd', 'recipientEmail', 'rateConRateUsd', 'negotiationStage']) assert.equal(fake.state.conversation[key], snapshot[key], key)
  assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 1)
})

test('evaluation uses the production compact reference and authoritative policy', () => {
  const context = brokerEvalContext({ posting: fakePosting(), carrier: null, text: 'I will rebroker to another carrier.' })
  assert.ok(context.systemPrompt.includes(ONE_CARRIER_RULE))
  assert.equal(context.negotiation.intent.kind, 'rebroker')
  assert.equal(context.negotiation.issuePaper, false)
  assert.ok(context.history[0].content.includes('REFERENCE RECORD'))
  assert.equal(brokerReplyProblem('No, one carrier only.', context.checkFacts), null)
})

test('uncertainty cannot hide a second weather or traffic claim', () => {
  for (const raw of ['No idea, but it is sunny here.', 'No idea, probably the usual Seattle drizzle.',
    "It’s a clear day out east, so traffic should be smooth.", "The traffic’s light on I-81 today.", "Traffic is heavy.",
    'I do not know the weather, it is sunny here.', 'I do not know whether it is raining, traffic is heavy.', 'If it rains, traffic is heavy here right now.', "Traffic’s usually light on that route."]) {
    assert.equal(inventsEnvironment(raw), true, raw)
    assert.equal(brokerReplyProblem(raw)?.unusable, true)
    assert.equal(driverReplyProblem(raw)?.unusable, true)
  }
  for (const raw of ["I don't have verified weather information.", "I don't know if it is sunny.", 'Is it raining?', 'If it rains, stay safe.']) assert.equal(inventsEnvironment(raw), false, raw)
})

test('a detention amount cannot authorize a stop fee', () => {
  for (const raw of ['Stop pay is $85 per stop.', 'No stop fee. But we pay $85 per stop.', 'We can cover extra stops for $85.',
    'Not a problem, stop pay is $85 per stop.', 'We do not offer detention, stop pay is $85 per stop.', 'Stop pay is $85 per stop, not $90.']) {
    assert.equal(stopPayInvented(raw), true, raw)
    assert.equal(brokerReplyProblem(raw)?.unusable, true)
  }
  assert.equal(stopPayInvented('No separate stop pay. Detention is $85 per hour.'), false)
  const check = BROKER_CASES.find((c) => c.id === 'EB22').expect({ posting: { rateUsd: 3000 }, terms: { detentionPerHour: 85 } })
  assert.ok(check('Stop pay is $85 per stop.').includes('stop pay invented'))
})

test('lateness has distinct unknown/on-time/late states and validates exact mixed duration', () => {
  const late = { etaAt: '2026-10-28T15:00:00Z', deliveryAt: '2026-10-28T12:00:00Z' }
  const onTime = { ...late, etaAt: '2026-10-28T11:00:00Z' }
  assert.deepEqual(latenessStatus(onTime), { kind: 'on-time', minutes: 0 })
  assert.equal(latenessProblem("I'm 10 hours late.", { load: late, requireAnswer: true }), 'gave the wrong lateness duration')
  assert.equal(latenessProblem("I'm three hours late.", { load: late, requireAnswer: true }), null)
  assert.equal(latenessProblem("I'm 10 hours late.", { load: onTime }), 'claimed lateness when the ETA is on time')
  assert.equal(latenessProblem('No, I am 10 hours late.', { load: onTime }), 'claimed lateness when the ETA is on time')
  assert.equal(latenessProblem('I am not on time, I am 3 hours late.', { load: late, requireAnswer: true }), null)
  assert.equal(latenessProblem('I have 10 hours driving left and I am 3 hours late.', { load: late, requireAnswer: true }), null)
  assert.equal(latenessProblem("I'm on time.", { load: {}, requireAnswer: true }), 'invented lateness without a verified ETA')
  assert.equal(latenessProblem("I'm 2 hours 30 minutes late.", { load: { ...late, etaAt: '2026-10-28T14:30:00Z' }, requireAnswer: true }), null)
  const check = DRIVER_CASES.find((c) => c.id === 'ED25').expect({ load: late })
  assert.ok(check("I'm 10 hours late.").length)
  assert.equal(driverReplyProblem("I'm 10 hours late.", { load: late, text: 'Are you late?' })?.unusable, true)
  for (const load of [null, {}, late, onTime]) assert.equal(latenessProblem(latenessLine(load), { load, requireAnswer: true }), null)
})

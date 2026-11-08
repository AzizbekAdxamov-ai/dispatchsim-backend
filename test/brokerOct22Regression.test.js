// Replays report failures offline. No network, database or personal addresses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chatIntent, negotiate, negotiationReplyProblem } from '../src/modules/brokerChat/negotiation.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { paperClaimProblem } from '../src/modules/brokerChat/paperTalk.js'
import { ceilingFor } from '../src/modules/brokerChat/ratePolicy.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'
import { turnRow } from '../src/modules/chat/turnLog.js'
import { readTurnLog, turnIssues, reportTotals, renderLiveReport } from '../scripts/brokerLiveReport.js'
import { liveScript, liveTurnFlags, runLive } from '../scripts/brokerLiveRunner.js'
import { buildDriverSystemPrompt, offerLines } from '../src/modules/driverChat/driverChat.prompt.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'

const posting = fakePosting({ rateUsd: 8153, distanceMi: 2180 })
const booking = { mc: { verdict: 'match' }, trailer: { fits: true } }
const step = (text, conversation = {}) => negotiate({ posting, booking, conversation, text, offerVisible: true })
const saved = (d) => ({ brokerOfferUsd: d.state.offer, agreedRateUsd: d.state.agreed,
  negotiationStage: d.state.stage, ratePushCount: d.state.pushes, bestCounterUsed: d.state.bestCounterUsed })

test('future email promises and the exact report wording are blocked in every paper state', () => {
  const replies = [
    'Sure, I’ll send the paperwork to dispatch@example.com shortly.',
    'The paperwork is being sent to dispatch@example.com shortly.',
    'The paperwork is heading to dispatch@example.com right now.',
    'The rate confirmation is on its way to your inbox.',
    "I'll email it to you shortly.", 'I will email the rate confirmation.',
    'Once agreed, I will send the paperwork to your email.',
    'I am emailing it now.',
    'I am not emailing it, I am sending the paperwork to dispatch@example.com.',
  ]
  for (const paper of [{ delivered: false }, { status: 'agreed', delivered: false }, { status: 'agreed', delivered: true }]) {
    for (const reply of replies) assert.equal(paperClaimProblem(reply, paper), 'claimed external email delivery of the rate confirmation', reply)
  }
})

test('contact addresses on paper, questions, denials and future in-chat delivery stay safe', () => {
  for (const reply of ['What email should I put on the rate confirmation?',
    'The contact email on the rate confirmation is dispatch@example.com.',
    "I won't send the paperwork to your email.", 'The paperwork is not being sent to dispatch@example.com.',
    'The rate confirmation will appear in this chat shortly.', 'Have you emailed the paperwork?',
    'The rate confirmation will be available here with dispatch@example.com as the contact.']) {
    assert.equal(paperClaimProblem(reply, { delivered: false }), null, reply)
  }
  assert.ok(paperClaimProblem("I won't send the paperwork to your email, but I'll send it to your inbox.", { delivered: true }))
  for (const paper of [{ delivered: false }, { delivered: true }]) {
    assert.equal(paperClaimProblem('I will send the rate confirmation here in chat with dispatch@example.com listed as the contact.', paper), null)
    assert.equal(paperClaimProblem('I am not emailing it now.', paper), null)
  }
})

test('explicit put-on recipient directions parse; quotes, conditions, holds and multiple recipients do not authorize', () => {
  for (const text of ['Put it on dispatch@example.com please.', 'Put dispatch@example.com on the rate con.',
    'Please put dispatch@example.com on the rate confirmation.']) {
    assert.equal(chatIntent(text).kind, 'email', text)
    assert.deepEqual(chatIntent(text).emails, ['dispatch@example.com'])
  }
  for (const text of ['Do not put it on dispatch@example.com.', 'Can you put it on dispatch@example.com?',
    'He said "put it on dispatch@example.com".', 'If needed, put it on dispatch@example.com.',
    'Once I confirm, put it on dispatch@example.com.',
    'Put it on a@example.com and use b@example.com.', 'Hold up, put it on dispatch@example.com.']) {
    assert.ok(!chatIntent(text).emails?.length, text)
  }
})

test('natural recipient directions issue one paper only after agreement and never through a hold', async () => {
  for (const suffix of ['', ' Once I confirm.', ' Hold up, dont book nothing yet.']) {
    const fake = makeFakeBrokerRepo({ posting, lines: ['Example Freight MC-741309.'] })
    const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
      findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
      logTurn: async () => {}, chatText: async () => 'Please confirm the rate first.' }
    const send = (text) => sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text }, { deps })
    // Band 4 (X5): an email given BEFORE the rate is agreed now issues the paper at agreement
    // (negotiationReleaseNov08.test.js), so this loop starts from a message with no recipient.
    await send('Hey, checking on this load.')
    assert.equal(fake.state.conversation.agreedRateUsd, null)
    assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
    await send('$8153 all-in works for me.')
    await send(`Put dispatch@example.com on the rate con${suffix || '.'}`)
    assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, suffix ? 0 : 1)
    assert.equal(fake.state.conversation.recipientEmail, suffix ? null : 'dispatch@example.com')
  }
})

test('holding a current rate cannot claim finality while a later authorized counter exists', () => {
  const first = step('Can you do better?')
  assert.equal(first.hasRateRoom, true)
  for (const reply of ['$8,153 all-in is my final rate.', 'My best offer is $8,153 all-in.',
    'I cannot go higher than $8,153 all-in.', 'I am not moving above $8,153 all-in.',
    '$8,153 is the most I can pay.']) assert.match(negotiationReplyProblem(reply, first), /permanent final/, reply)
  // Kills: guarding the old posted amount after the first authorized concession.
  const current = first.state.offer.toLocaleString('en-US')
  assert.equal(negotiationReplyProblem(`I am at $${current} all-in on this one right now.`, first), null)
  assert.equal(negotiationReplyProblem(`My best offer right now is $${current} all-in.`, first), null)
  assert.equal(negotiationReplyProblem(`This is not my final rate. My offer is $${current}.`, first), null)
  const second = step('Bro add a little bit.', saved(first))
  assert.ok(second.state.offer > first.state.offer)
  const exhausted = step('What is your rate?', { brokerOfferUsd: ceilingFor(posting) })
  assert.equal(exhausted.hasRateRoom, false)
  assert.equal(negotiationReplyProblem(`My final rate is $${ceilingFor(posting)} all-in.`, exhausted), null)
})

test('locked in, locked at and set confirmations preserve the agreed amount; omission gives precise retry guidance', () => {
  const accepted = step('$8153 all-in works for me.')
  for (const reply of ['$8,153 all-in, locked in. What email should I put on the rate confirmation?',
    'Locked at $8,153 all-in. What email should I put on the rate confirmation?',
    '$8,153 all-in, set. What email should I put on the rate confirmation?']) {
    assert.equal(negotiationReplyProblem(reply, accepted), null, reply)
  }
  const problem = brokerReplyProblem('Locked in. What email should I put on the rate confirmation?', { negotiation: accepted })
  assert.match(problem.why, /omitted the agreed rate/)
  assert.match(problem.hint, /\$8,153 all-in/)
})

test('walkaway with an agreement withdraws paper; unagreed one-time best counter remains bounded', () => {
  const agreed = step('$8153 all-in works for me.')
  const withdrawn = step("I'll pass on it.", saved(agreed))
  assert.equal(withdrawn.state.agreed, null)
  assert.equal(withdrawn.invalidatePaper, true)
  assert.equal(withdrawn.state.bestCounterUsed, false)
  const counter = step("I'll pass on it.")
  assert.equal(counter.state.bestCounterUsed, true)
  assert.equal(counter.state.offer, ceilingFor(posting))
  assert.equal(counter.issuePaper, false)
  assert.equal(step("I'll pass on it.", saved(counter)).state.offer, counter.state.offer)
})

test('serialized turn telemetry counts fallback, regeneration, provider errors and known tokens independently', () => {
  const row = turnRow({ chat: 'broker', model: 'configured', reply: 'Holding here.', regeneratedBecause: 'wrong rate',
    fellBack: true, providerRequests: 3, attempts: [
      { n: 1, model: 'primary', status: 429, outcome: 'rate_limited', usage: null },
      { n: 2, model: 'answered', status: 200, outcome: 'ok', usage: { total: 10 } },
      { n: 3, model: 'answered', status: 200, outcome: 'ok', usage: { total: 12 } },
    ] })
  const turn = readTurnLog(row)
  assert.equal(turn.model, 'answered')
  assert.equal(turn.reportedTokens, 22)
  assert.equal(turn.tokenUsageComplete, false)
  assert.equal(turn.usedFallback, true)
  assert.ok(turnIssues(turn).some((s) => s.includes('429')))
  assert.ok(turnIssues(turn).some((s) => s.includes('fell back')))
  assert.ok(turnIssues(turn).some((s) => s.includes('regenerated')))
  const totals = reportTotals([{ turns: [turn] }])
  assert.equal(totals.providerRequests, 3)
  assert.equal(totals.fallbacks, 1)
  assert.equal(totals.flaggedTurns, 1)
  const report = renderLiveReport('chat', [{ turns: [turn], name: 'Fixture' }], { model: 'configured' },
    { startedAt: '2026-10-22T00:00:00Z', finishedAt: '2026-10-22T00:01:00Z', plannedLoads: 3 })
  assert.match(report, /In-memory fixture/)
  assert.match(report, /No live database/)
  assert.match(report, /deliverAll/)
  assert.match(report, /Raw provider replies/)
  assert.match(report, /INCOMPLETE|Completed loads: 1\/3/)
  row[16] = 'malformed'
  assert.equal(readTurnLog(row).model, 'configured')
})

test('live entries do not contact network when imported or discovered by node --test', async () => {
  await assert.rejects(runLive('chat'), /Manual use only/)
  for (const mode of ['chat', 'push', 'ratecon', 'walkaway']) {
    const result = spawnSync(process.execPath, ['--test', `scripts/broker-${mode}-live.test.js`], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /REPORT_PATH is required/)
  }
})

test('street fixtures exercise informal intent and identity gates without requiring slang from a formal broker', () => {
  const fixture = { ...posting, originCity: 'Toledo', destinationCity: 'Yakima' }
  const lines = liveScript('chat', fixture)
  assert.equal(lines[0], 'wassap brother')
  assert.equal(chatIntent(lines[3]).kind, 'offer')
  assert.equal(chatIntent(lines[4]).kind, 'offer')
  assert.equal(chatIntent(lines[5]).kind, 'hold')
  const trace = { agreed: null, paperCount: 0, offer: 8153, ceiling: 9000 }
  assert.deepEqual(liveTurnFlags('chat', 0, { reply: 'Good afternoon. Still got this one.', trace }, fixture), [])
  assert.ok(liveTurnFlags('chat', 0, { reply: 'May I have your MC?', trace }, fixture).includes('identity gate before agreement'))
})

test('the observed resting-driver legal ETA and timezone claims stay unverified; a greeting remains ordinary', () => {
  const driver = { name: 'Grace', cdlClass: 'A', payModel: 'permile', payPerMileCents: 70, dutyStatus: 'resting',
    truckId: 'TRK-1', trailerType: null, trailerLengthFt: null, currentCity: 'Seattle', currentState: 'WA', hosRemainingMin: null }
  const offer = { city: 'Great Falls', state: 'MT', miles: 608, restEndUnknown: true, earliestAt: null,
    pickupAt: new Date('2026-10-20T12:36:00Z') }
  for (const reply of ['Yes, can make it legal. I would be there at 2:30 am PT.',
    'My 10-hour rest ends at 12:26 PM PT (3:26 PM Central).']) {
    const problem = driverReplyProblem(reply, { driver, offer, text: 'What is your legal ETA to pickup?' })
    assert.equal(problem.why, 'gave an unverified rest end or arrival time')
    assert.doesNotMatch(problem.safeReply, /\d{1,2}:\d{2}/)
  }
  assert.equal(driverReplyProblem('Doing all right, boss. You got a load?', { driver, text: 'wassap brother' }), null)
  const prompt = buildDriverSystemPrompt({ driver, offer, load: null,
    standing: { stage: 'ok', unpaidCount: 0, owedUsd: 0, daysOverdue: 0 } })
  assert.match(prompt, /truck record does not list a trailer type/)
  assert.match(prompt, /Trailer length is not recorded/)
  assert.doesNotMatch(prompt, /Driving time left today:|53-foot|48-foot/)
  assert.match(offerLines(offer).join('\n'), /You don't know when your ten is up/)
})

test('actual street acceptance is recognized but cannot confirm a rate without the correct MC', async () => {
  const acceptedText = 'aight $8153 works for me bro lets run it'
  assert.deepEqual(chatIntent(acceptedText), { kind: 'accept_amount', rateUsd: 8153, emails: [], useOwnEmail: false })
  for (const text of ['alright $8,153 all-in works for me brother lets run it',
    'okay 8153 works for us bro', '$8153 works for me bro']) assert.equal(chatIntent(text).kind, 'accept_amount', text)
  for (const text of ['If aight $8153 works for me bro lets run it, what then?',
    'He said "aight $8153 works for me bro lets run it".', 'aight $8153 does not work for me bro lets run it',
    'aight $8153 works for me bro lets run it but dont book yet']) {
    assert.ok(!['accept', 'accept_amount'].includes(chatIntent(text).kind), text)
  }
  for (const verified of [false, true]) {
    const fake = makeFakeBrokerRepo({ posting, lines: verified ? ['Example Freight MC-741309.'] : [] })
    const logs = []
    const raw = 'Great, we’re set at $8,153 all-in. I’ll get the paperwork over and confirm the Saturday pickup in Toledo.'
    const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
      findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
      logTurn: async (row) => logs.push(row), chatText: async () => verified
        ? '$8,153 all-in agreed. What email should I put on the rate confirmation?' : raw }
    await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: acceptedText }, { deps })
    fake.deliverAll()
    assert.equal(fake.state.conversation.agreedRateUsd, verified ? 8153 : null)
    assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 0)
    const reply = fake.state.messages.filter((m) => m.role === 'broker').at(-1).content
    if (!verified) {
      // Kills: asking for a correct MC before one was provided.
      assert.match(reply, /what.s your MC/i)
      assert.equal(logs.at(-1)[12], true)
      assert.doesNotMatch(reply, /we're set|we’re set|paperwork over/)
    }
  }
})

test('unagreed set/locked-in claims are blocked and a settlement must request the missing MC', () => {
  const decision = negotiate({ posting, booking: { mc: { verdict: null } }, conversation: {},
    text: 'aight $8153 works for me bro lets run it', offerVisible: true })
  assert.equal(decision.requiresMc, true)
  for (const reply of ["We're set at $8,153 all-in.", 'We are all set at $8,153.',
    "We're locked in at $8,153.", 'Locked in at $8,153.', 'Locked at $8,153.']) {
    assert.equal(negotiationReplyProblem(reply, decision), 'invented an agreement without dispatcher acceptance', reply)
  }
  assert.equal(negotiationReplyProblem('I am at $8,153 all-in.', decision), 'did not request the MC required before confirming the rate')
  assert.equal(negotiationReplyProblem('What is your MC number?', decision), null)
  assert.equal(negotiationReplyProblem(decision.line, decision), null)
  assert.equal(step('wassap brother').requiresMc, false)
  assert.equal(step('Can you meet me at $8700?').requiresMc, false)
})

test('actual deadhead counter keeps the requested price and best-we-can-do is not a permanent limit', () => {
  const text = '8153 kinda low brother got 300 miles deadhead can u meet me at 8700?'
  assert.equal(chatIntent(text).kind, 'offer')
  assert.equal(chatIntent(text).rateUsd, 8700)
  const decision = step(text)
  const reply = 'I get the deadhead, but the best we can do is $8,153 all-in, including linehaul and fuel.'
  assert.equal(negotiationReplyProblem(reply, decision), 'claimed a permanent final rate while authorized bargaining room remains')
  assert.equal(negotiationReplyProblem('The best I can do is $8,153 all-in.', decision), 'claimed a permanent final rate while authorized bargaining room remains')
  // Kills: treating the posted rate as the new authorized counter.
  assert.equal(negotiationReplyProblem(`The best we can do right now is $${decision.state.offer.toLocaleString('en-US')} all-in.`, decision), null)
})

// Live 2026-11-05, the Chicago→Dallas thread: the dispatcher pushed and the
// broker never moved, because neither the push nor the finality was read for
// what it was.
test('a misspelled example counter raises the offer and a cannot-increase line is a final claim', () => {
  // Kills: "can add some money for exapmle 3700" read as small talk --
  // the aliased example word, the missing "you" and "some money" for "more".
  for (const text of ['can add some money for exapmle 3700', 'can you add more. for exampel 4000.',
    'sir can add some money for exmaple 4600']) {
    const intent = chatIntent(text)
    assert.equal(intent.kind, 'offer', text)
    assert.ok(intent.rateUsd > 0, text)
  }
  const decision = negotiate({
    // The live shape: the posted quote is 3,500 and the example counter 3,700
    // sits above it, so the ladder must move the offer upward.
    posting: fakePosting({ rateUsd: 3500, distanceMi: 900 }),
    booking, conversation: {},
    text: 'can add some money for exapmle 3700', offerVisible: true,
  })
  assert.equal(decision.intent.kind, 'offer')
  assert.equal(decision.intent.rateUsd, 3700)
  assert.ok(decision.state.offer > 3500, `offer did not move: ${decision.state.offer}`)
  // Kills: the model ending bargaining in other words ("unable to
  // increase", "can't raise") that the old permanence list did not know.
  const room = step('Can you do better?')
  const current = room.state.offer.toLocaleString('en-US')
  for (const reply of [`Our quote remains $${current} all-in; we're unable to increase it.`,
    `I can't raise the rate above $${current}.`, 'We are not bumping the rate.']) {
    assert.match(negotiationReplyProblem(reply, room), /permanent final/, reply)
  }
  // Kills: "not included" (fuel) reading as a finality claim.
  assert.equal(negotiationReplyProblem(`The $${current} is total; fuel is not included in it.`, room), null)
})

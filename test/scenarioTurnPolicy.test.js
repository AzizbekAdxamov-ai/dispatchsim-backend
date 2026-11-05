// chat:scenarios and chat:eval must walk the same path as the live broker
// service: the server's cancellation policy first, then the live context and
// reply checks. The runner needs a database and a provider, so these tests
// read its source and replay S10/S11 through the shared helpers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { cancellationDecision } from '../src/modules/brokerChat/blockPolicy.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { brokerCancellationFindings, brokerWaitNoEtaFindings } from '../scripts/scenarioChecks.js'
import {
  brokerTurnContext, newConversation, conversationAfterTurn, conversationAfterWithdrawal,
} from '../scripts/brokerEvalContext.js'
import { PROMPT_VERSION } from '../src/modules/brokerChat/brokerChat.service.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

// Kills: chat-scenarios.js:267 old prompt; scenarioChecks.js:87,96 never called
test('the scenario runner uses the live path and judges S10/S11 on their outcome', () => {
  const src = read('../scripts/chat-scenarios.js')
  assert.doesNotMatch(src, /buildBrokerSystemPrompt/)
  assert.match(src, /brokerTurnContext\(/)
  assert.match(src, /cancellationDecision\(/)
  assert.match(src, /brokerCancellationFindings\(\{/)
  assert.match(src, /brokerWaitNoEtaFindings\(\{/)
  assert.match(src, /PROMPT_VERSION as brokerPromptVersion/)
  assert.equal(typeof PROMPT_VERSION, 'string')
})

// Kills: EB25/EB26 sent to the model on an open thread (policy never reached)
test('the eval runs the server policy for cases that fix a thread status', () => {
  const src = read('../scripts/chat-eval.js')
  assert.match(src, /c\.status \? cancellationDecision\(\{ status: c\.status, text: line \}\)/)
  assert.match(src, /fixed: policy\?\.line \?\? null/)
  assert.match(src, /if \(fixed\) \{\s+return \{ reply: fixed, model: 'server-policy'/)
})

const posting = fakePosting({ rateUsd: 3000, distanceMi: 970 })
const carrier = { name: 'Cedar Ridge Transport Services', mcNumber: 'MC-741309', email: null }

// Kills: S10 judged without the block and the invalidated paper being recorded
test('S10 replay: agreed thread + cancel -> blocked, paper invalidated, no findings', () => {
  const booked = negotiate({
    conversation: newConversation(), posting, text: 'deal', offerVisible: true,
    booking: { mc: { verdict: 'match' }, trailer: { fits: true } },
  })
  let conversation = conversationAfterTurn(newConversation(), booked)
  assert.equal(conversation.status, 'agreed')
  const policy = cancellationDecision({ status: conversation.status, text: "truck broke down, I can't cover it — cancel the load", brokerSaid: [] })
  assert.equal(policy.action, 'block')
  conversation = conversationAfterWithdrawal(conversation)
  assert.equal(conversation.status, 'open')
  assert.deepEqual(brokerCancellationFindings({ replies: [policy.line], blocked: true, paperInvalidated: true }), [])
})

// Kills: S11 replay ending without the load reclaimed, or with a block
test('S11 replay: wait asks for the ETA, no ETA reclaims without a block', () => {
  const first = cancellationDecision({ status: 'agreed', text: 'truck is not working, can you wait?', brokerSaid: [] })
  assert.equal(first.action, 'ask_eta')
  const second = cancellationDecision({ status: 'agreed', text: 'I have no ETA yet', brokerSaid: [first.line] })
  assert.equal(second.action, 'reclaim')
  assert.deepEqual(brokerWaitNoEtaFindings({ replies: [first.line, second.line], blocked: false }), [])
})

// Kills: the scenario turn context drifting from the service (no live prompt, no booked flag)
test('brokerTurnContext builds the live prompt and marks an agreed thread as booked', () => {
  const thread = [{ role: 'dispatcher', content: 'what is your mc', kind: 'text' }]
  const ctx = brokerTurnContext({
    posting, carrier, thread, text: 'what is your mc',
    conversation: { ...newConversation(), status: 'agreed', agreedRateUsd: 3000 },
  })
  assert.ok(ctx.systemPrompt.includes('CURRENT TASK'))
  assert.equal(ctx.history[0].role, 'dispatcher')
  assert.equal(ctx.checkFacts.bookedHere, true)
  assert.equal(ctx.checkFacts.text, 'what is your mc')
})

// Kills: TURNS counting policy-answered lines as model requests (budget guard planned S10:3, S11:4)
test('S10 and S11 plan only the model-answered lines', () => {
  assert.match(read('../scripts/chat-scenarios.js'), /S10: 5, S11: 5,/)
})

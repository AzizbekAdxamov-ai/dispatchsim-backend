// Band 4 (X5) through the real service with an in-memory repo: the email comes
// first, the deal later, and the broker never asks for the email again.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

// Kills: dropping knownEmail from the service call (the paper waited on a second "What email?")
test('email first, then "Deal." with the MC: the paper goes to that email and the email is not asked for again', async () => {
  const posting = fakePosting({ rateUsd: 8153, distanceMi: 2180 })
  const fake = makeFakeBrokerRepo({ posting, lines: ['Example Freight MC-741309. 53-foot dry van, driver is Ethan, truck #12.'] })
  let reply = 'Hey, what can I help with on this one?'
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => reply }
  const send = async (text, answer) => {
    reply = answer
    const result = await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text }, { deps })
    fake.deliverAll()
    return result
  }

  await send('Put it on dispatch@example.com please.', 'Please confirm the rate first.')
  assert.equal(fake.state.conversation.agreedRateUsd, null)
  await send('Is this still open?', 'We are at $8,153 all-in on this one.')
  await send('Deal. MC 741309.', '$8,153 confirmed. The rate confirmation will appear here shortly for you to review and sign.')

  assert.equal(fake.state.conversation.agreedRateUsd, 8153)
  assert.equal(fake.state.conversation.recipientEmail, 'dispatch@example.com')
  assert.equal(fake.state.messages.filter((m) => m.kind === 'rate_con').length, 1)
  const brokerLines = fake.state.messages.filter((m) => m.role === 'broker' && m.kind === 'text').map((m) => m.content)
  assert.ok(brokerLines.every((line) => !/\b(?:which|what) e-?mail\b/i.test(line)), brokerLines.join(' | '))
})

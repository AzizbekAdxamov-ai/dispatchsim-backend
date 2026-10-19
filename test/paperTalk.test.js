import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paperLines, paperNextLine } from '../src/modules/brokerChat/paperTalk.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { buildBrokerSystemPrompt, callerBlock } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const open = { status: 'open', delivered: false }
const pending = { status: 'agreed', delivered: false }
const arrived = { status: 'agreed', delivered: true }

test('a text-only sent claim cannot substitute for an actual delivered card', () => {
  for (const paper of [open, pending]) {
    for (const reply of ['Rate confirmation sent.', 'Rate confirmation attached. Look it over and send it back signed.', 'I have issued the rate con.', 'The rate confirmation is available here in the thread.', 'The rate confirmation is ready.', 'No driver assist is needed; the rate confirmation is attached.']) {
      const problem = brokerReplyProblem(reply, { paper })
      assert.equal(problem?.unusable, true, reply)
      assert.equal(problem.safeReply, paperNextLine(paper))
      assert.equal(brokerReplyProblem(problem.safeReply, { paper }), null)
    }
  }
  assert.equal(brokerReplyProblem('Rate confirmation attached. Look it over and send it back signed.', { paper: arrived }), null)
})

test('external email delivery is unsupported even after agreement or booking', () => {
  for (const paper of [open, pending, arrived, { status: 'booked', delivered: true }]) {
    for (const reply of ['Rate confirmation sent to carrier@example.com.', 'The rate confirmation was emailed to your inbox.', "I've emailed it to you.", 'Sent to carrier@example.com.', "I've sent it to your email.", 'I sent it to your inbox.', 'Rate confirmation sent to your email, and you can review it now.']) {
      assert.equal(brokerReplyProblem(reply, { paper })?.unusable, true)
    }
  }
})

test('terms, contact email questions, denials and conditional paper steps stay natural', () => {
  for (const reply of [
    'Detention is $85 an hour after two hours.',
    'What is your contact email?',
    "I haven't sent the rate confirmation yet.",
    'Once you press Agree, the rate confirmation will appear here.',
    'The rate confirmation is not attached yet.',
    'Please send your contact email.',
    "I haven't sent it to your email.",
    'Have you sent the rate confirmation?',
    'Once the rate confirmation is attached, you can review it.',
    'The rate confirmation will be available here after Agree.',
  ]) assert.equal(brokerReplyProblem(reply, { paper: open }), null, reply)
})

test('the prompt receives actual paper state, independent of the dialogue', () => {
  const posting = fakePosting()
  const base = { broker: { name: 'Broker', contactName: 'Renata', persona: 'Calm.' }, posting }
  assert.match(buildBrokerSystemPrompt({ ...base, paper: open }), /No agreed rate is recorded/)
  assert.match(buildBrokerSystemPrompt({ ...base, paper: pending }), /still on its way/)
  assert.match(buildBrokerSystemPrompt({ ...base, paper: arrived }), /available in this thread/)
  assert.match(paperLines(open).join(' '), /never to external email/)
  const facts = bookingFacts({ texts: [], posting })
  assert.doesNotMatch(callerBlock(facts).join(' '), /email to send the rate confirmation/)
})

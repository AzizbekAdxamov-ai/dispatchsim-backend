// 2026-11-15 live run (Harbor Line): "that's the offer" before the ceiling,
// "Like I said" in front of a new figure, a sentence said twice in a row.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { negotiate, negotiationLines } from '../src/modules/brokerChat/negotiation.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import {
  varyRepeat, repeatsRecent, dropStaleRepeatLead, dropRepeatedSentences, repeatedSentences, sharesSpan,
  REPEAT_SPAN_MIN_WORDS, REPEAT_LEADS,
} from '../src/modules/brokerChat/repeatGuard.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({ rateUsd: 3500, distanceMi: 1500 })
const matched = { mc: { verdict: 'match' }, trailer: { fits: true } }
const open = (extra = {}) => ({ status: 'open', negotiationStage: 'negotiating', brokerOfferUsd: posting.rateUsd, ...extra })
const ASK = 'Can you do $4,000 all-in?'
const decide = (conversation = open(), text = ASK) =>
  negotiate({ conversation, posting, text, booking: matched, offerVisible: true })
const problemFor = (reply, decision, text = ASK) =>
  brokerReplyProblem(reply, { posting, negotiation: decision, text, booking: matched })

// The ladder's own current quote, as the dollars the reply would carry.
const quote = (decision) => `$${decision.state.offer.toLocaleString('en-US')}`
const LAST = "i can do $3,750 all-in. i hear you on the early pickup window you mentioned."
const NEXT = "i can do $3,825 all-in. i hear you on the early pickup window you mentioned."

// Kills: dropping "that's the offer" from the final-price guard (live reply passed)
test("calling the quote 'the offer' is refused while there is room, allowed at the ceiling", () => {
  const roomy = decide()
  assert.equal(roomy.hasRateRoom, true)
  assert.match(problemFor(`our current quote is ${quote(roomy)} all-in. that's the offer.`, roomy).why, /permanent final rate/)
  assert.equal(problemFor(`our current quote is ${quote(roomy)} all-in. that's the offer.`, { ...roomy, hasRateRoom: false }), null)
})

// Kills: removing take-it-or-leave-it / final / firm / all-I-can from the guard
test('other firm-sounding closers are refused while there is room', () => {
  const roomy = decide()
  for (const line of [
    `our current quote is ${quote(roomy)} all-in. take it or leave it.`,
    `that is final, ${quote(roomy)} all-in.`,
    `my price is firm at ${quote(roomy)} all-in.`,
    `that's all I can do on this one, ${quote(roomy)} all-in.`,
  ]) assert.ok(problemFor(line, roomy), line)
  // Ordinary words around the same letters are not a claim.
  assert.equal(problemFor(`our current quote is ${quote(roomy)} all-in. final delivery is Friday.`, roomy), null)
})

// Kills: dropping the "do not call the quote final" prompt line
test('the decision prompt tells the model not to call the quote final', () => {
  assert.match(negotiationLines(decide()).join('\n'), /Do not call the quote final, firm, the max or "the offer"/)
})

// Kills: repeatsRecent ignoring figures (a new price still counted as a repeat)
test('a changed figure is not a repeat; the same figure is', () => {
  assert.equal(repeatsRecent(NEXT, [LAST]), false)
  assert.equal(repeatsRecent(LAST, [LAST]), true)
})

// Kills: varyRepeat putting "Like I said" in front of a new figure
test('varyRepeat leads a repeat only when the figure is unchanged', () => {
  assert.equal(varyRepeat(NEXT, [LAST]), NEXT)
  assert.ok(REPEAT_LEADS.some((lead) => varyRepeat(LAST, [LAST]).startsWith(lead)))
})

// Kills: dropStaleRepeatLead keeping the lead on a new figure, or stripping it on the same figure
test('a lead the model wrote itself goes when the figure changed and stays when it did not', () => {
  const said = ['i can do $3,750 all-in.']
  assert.equal(dropStaleRepeatLead('Like I said, i can do $3,825 all-in.', said), 'i can do $3,825 all-in.')
  assert.equal(dropStaleRepeatLead('Still the same - i can do $3,825 all-in.', said), 'i can do $3,825 all-in.')
  assert.equal(dropStaleRepeatLead('Like I said, i can do $3,750 all-in.', said), 'Like I said, i can do $3,750 all-in.')
  assert.equal(dropStaleRepeatLead('Like I said, no change.', said), 'Like I said, no change.')
  assert.equal(dropStaleRepeatLead('Like I said, i can do $3,825 all-in.', []), 'Like I said, i can do $3,825 all-in.')
})

// Kills: a different REPEAT_SPAN_MIN_WORDS (5-word echoes flagged, or 6-word ones missed)
test('a sentence sharing a span of the minimum length with the last message is dropped', () => {
  assert.equal(REPEAT_SPAN_MIN_WORDS, 6)
  assert.equal(dropRepeatedSentences(NEXT, [LAST]), 'i can do $3,825 all-in.')
  const five = 'one two three four five'
  assert.equal(sharesSpan(five, `${five} six`), false)
  assert.equal(sharesSpan(`${five} six`, `${five} six`), true)
})

// Kills: dropping a sentence that carries the figure, or emptying the reply
test('the quote sentence is never dropped and a reply of only echoes is returned whole', () => {
  const quote = 'i can do $3,750 all-in right now.'
  assert.equal(dropRepeatedSentences(`${quote} pickup is at 8.`, [quote]), `${quote} pickup is at 8.`)
  const echo = "i hear you on the early pickup window you mentioned."
  assert.equal(dropRepeatedSentences(echo, [echo]), echo)
})

// Kills: no regeneration reason for a repeated sentence in an otherwise new reply
test('a reply repeating a sentence is flagged for one regeneration, not as unusable', () => {
  const lower = NEXT.replace('3,825', '3,400')
  const problem = brokerReplyProblem(lower, { posting, brokerSaid: [LAST] })
  assert.equal(problem?.why, 'repeated a sentence from your last reply')
  assert.equal(problem.unusable, false)
  assert.equal(brokerReplyProblem('i can do $3,400 all-in. pickup is at 8.', { posting, brokerSaid: [LAST] }), null)
})

// Kills: drop leaving a shared span behind when another sentence is available
test('after the guard consecutive messages share no span of the minimum length', () => {
  const prior = 'one two three four five six seven eight.'
  const reply = 'one two three four five six seven eight. and then something else entirely.'
  const out = dropRepeatedSentences(reply, [prior])
  assert.equal(out, 'and then something else entirely.')
  assert.equal(sharesSpan(out, prior), false)
  assert.equal(repeatedSentences(out, [prior]).length, 0)
})

// Kills: the service skipping the drop / stale-lead cleanup
test('the service sends a model reply without the echoed sentence and without a stale lead', async () => {
  const fake = makeFakeBrokerRepo({ posting, lines: [] })
  const replies = [
    "i hear you on the early pickup window you mentioned. it is still available.",
    "Like I said, i hear you on the early pickup window you mentioned. pickup is at 8 sharp.",
    "Like I said, i hear you on the early pickup window you mentioned. pickup is at 8 sharp.",
  ]
  const deps = { repo: fake.repo, getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-741309' }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => replies.shift() ?? 'pickup is at 8 sharp.' }
  const send = (text) => sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text }, { deps })
  await send('Is it still available?')
  fake.deliverAll()
  await send('And pickup?')
  const last = fake.state.messages.filter((m) => m.role === 'broker').at(-1)
  assert.ok(!/early pickup window/.test(last.content), last.content)
  assert.ok(!/like i said/i.test(last.content), last.content)
  assert.match(last.content, /pickup is at 8 sharp/)
})

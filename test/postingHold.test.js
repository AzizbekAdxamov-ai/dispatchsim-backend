// A posting held for one conversation once the price is agreed (migration 077):
// the pure rules, then the service with the in-memory repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOLD_MINUTES, EXPIRY_WARNING_MINUTES, COVERED_LINE, NOTICE_WARN, NOTICE_COVERED,
  effectiveExpiry, heldByOther, holdEnded, expiryNotice, minutesLeft,
} from '../src/modules/brokerChat/postingHold.js'
import { sendMessage, getThread, assertPostingOpen } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const MS_PER_MINUTE = 60_000
const NOW = new Date('2026-11-15T12:00:00Z')
const at = (minutes) => new Date(NOW.getTime() + minutes * MS_PER_MINUTE).toISOString()
const MINUTE_BEFORE_WARNING = EXPIRY_WARNING_MINUTES + 1
const CONV = FAKE_IDS.conversation
const OTHER_CONV = 'other-conversation'
const expired = at(-HOLD_MINUTES)

const held = (heldUntil, over = {}) => ({ expiresAt: expired, heldByConversationId: CONV, heldUntil, ...over })

test('the hold carries its own conversation past the posted expiry, and no one else', () => {
  assert.equal(effectiveExpiry(held(at(MINUTE_BEFORE_WARNING)), CONV).toISOString(), at(MINUTE_BEFORE_WARNING))
  // Kills: effectiveExpiry ignoring the hold (the live "This load has expired." while the paper was still open)
  assert.equal(effectiveExpiry(held(at(MINUTE_BEFORE_WARNING)), OTHER_CONV).toISOString(), expired)
  // Kills: the hold extending every conversation, not only the holder
})

test('a hold never shortens the posted expiry', () => {
  const later = at(HOLD_MINUTES * 10)
  assert.equal(effectiveExpiry(held(at(1), { expiresAt: later }), CONV).toISOString(), later)
  // Kills: effectiveExpiry returning heldUntil when it is earlier than expiresAt
})

test("a running hold is another dispatcher's lock; an ended hold or one's own is not", () => {
  assert.equal(heldByOther(held(at(1)), OTHER_CONV, NOW), true)
  assert.equal(heldByOther(held(at(1)), CONV, NOW), false)
  // Kills: heldByOther true for the holder (the holder locked out of its own posting)
  assert.equal(heldByOther(held(at(-1)), OTHER_CONV, NOW), false)
  // Kills: heldByOther ignoring held_until (a lock that never lets go)
  assert.equal(heldByOther({ heldByConversationId: null, heldUntil: null }, OTHER_CONV, NOW), false)
})

test('the warning is due once, inside the warning window only', () => {
  const args = { posting: held(at(EXPIRY_WARNING_MINUTES)), conversationId: CONV, now: NOW }
  assert.equal(expiryNotice(args), NOTICE_WARN)
  assert.equal(expiryNotice({ ...args, warnedAt: NOW }), null)
  // Kills: the warning repeating on every read
  assert.equal(expiryNotice({ ...args, posting: held(at(MINUTE_BEFORE_WARNING)) }), null)
  // Kills: the warning sent before the window opens
  assert.equal(expiryNotice({ ...args, conversationId: OTHER_CONV }), null)
  assert.equal(expiryNotice({ ...args, status: 'booked' }), null)
})

test('"covered" is due once, after the hold; a plain expiry has no notice', () => {
  const ended = { posting: held(at(-1)), conversationId: CONV, now: NOW }
  assert.equal(expiryNotice(ended), NOTICE_COVERED)
  assert.equal(expiryNotice({ ...ended, noticedAt: NOW }), null)
  // Kills: the covered line posted again on every read
  assert.equal(expiryNotice({ ...ended, posting: { expiresAt: expired } }), null)
  // Kills: a conversation that never held the posting told "covered"
  assert.equal(holdEnded(held(at(-1)), CONV, NOW), true)
  assert.equal(holdEnded(held(at(1)), CONV, NOW), false)
})

test('minutes left rounds up and is never zero', () => {
  assert.equal(minutesLeft(at(EXPIRY_WARNING_MINUTES), NOW), EXPIRY_WARNING_MINUTES)
  assert.equal(minutesLeft(new Date(NOW.getTime() + 1).toISOString(), NOW), 1)
  assert.equal(minutesLeft(new Date(NOW.getTime() + MS_PER_MINUTE * 4.5).toISOString(), NOW), EXPIRY_WARNING_MINUTES)
  // Kills: floor instead of ceil ("about 0 more minutes")
})

// ---- the service, with the in-memory repo ----

function setup(postingOver) {
  const fake = makeFakeBrokerRepo({ posting: fakePosting(postingOver) })
  const notices = []
  const original = fake.repo.getConversation
  fake.repo.deliverExpiryNotice = async (id, kind, line) => {
    const column = kind === NOTICE_WARN ? 'expiryWarnedAt' : 'expiryNoticedAt'
    if (fake.state.conversation[column]) return false
    fake.state.conversation[column] = new Date().toISOString()
    if (line) { notices.push(line); await fake.repo.addMessage(id, 'broker', line) }
    return true
  }
  fake.repo.getConversation = async (...a) => {
    const row = await original(...a)
    return row && { ...row, expiryWarnedAt: fake.state.conversation.expiryWarnedAt, expiryNoticedAt: fake.state.conversation.expiryNoticedAt }
  }
  let modelCalls = 0
  const deps = {
    repo: fake.repo, getCarrier: async () => ({}), findById: async () => ({}),
    chatText: async () => { modelCalls += 1; return 'ok' },
    assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'm' }), logTurn: async () => {},
  }
  return { fake, deps, notices, modelCalls: () => modelCalls, ids: { conversationId: CONV, userId: FAKE_IDS.user } }
}
const minutesFromNow = (m) => new Date(Date.now() + m * MS_PER_MINUTE).toISOString()
const heldPosting = (heldUntilMin, over = {}) => ({
  expiresAt: minutesFromNow(-HOLD_MINUTES), heldByConversationId: CONV, heldUntil: minutesFromNow(heldUntilMin), ...over,
})

test('a thread whose posting expired while held still reads, with the hold as its end', async () => {
  const t = setup(heldPosting(HOLD_MINUTES))
  const thread = await getThread(t.ids, { deps: t.deps })
  assert.equal(thread.expiry.held, true)
  assert.ok(new Date(thread.expiry.expiresAt) > new Date())
  // Kills: getThread reporting the raw expires_at to the countdown
})

test('an expired posting is open to the conversation that holds it, taken for another', () => {
  const posting = fakePosting(heldPosting(HOLD_MINUTES))
  assert.doesNotThrow(() => assertPostingOpen(posting, CONV))
  // Kills: assertPostingOpen reading raw expiresAt (the live "This load has expired.")
  assert.throws(() => assertPostingOpen(fakePosting(heldPosting(HOLD_MINUTES, { heldByConversationId: OTHER_CONV })), CONV), { code: 'POSTING_TAKEN' })
  // Kills: a hold for another conversation ignored
  const theirs = fakePosting(heldPosting(HOLD_MINUTES, { heldByConversationId: OTHER_CONV, expiresAt: minutesFromNow(HOLD_MINUTES) }))
  assert.throws(() => assertPostingOpen(theirs, null), { code: 'POSTING_TAKEN' })
  // Kills: opening a thread on a posting held for someone else
  assert.throws(() => assertPostingOpen(fakePosting({ expiresAt: minutesFromNow(-1) }), CONV), { code: 'POSTING_EXPIRED' })
})

test('the warning goes into the thread once, with the minutes left', async () => {
  const t = setup(heldPosting(EXPIRY_WARNING_MINUTES - 1))
  await getThread(t.ids, { deps: t.deps })
  await getThread(t.ids, { deps: t.deps })
  assert.equal(t.notices.length, 1)
  assert.match(t.notices[0], new RegExp(`${EXPIRY_WARNING_MINUTES - 1} more minutes`))
  // Kills: no idempotence (two readers, two warnings)
})

test('after the hold, the broker says the load got covered without a model call', async () => {
  const t = setup(heldPosting(-1))
  const out = await sendMessage({ ...t.ids, text: 'ok send the rc' }, { deps: t.deps })
  assert.equal(out.covered, true)
  assert.equal(t.modelCalls(), 0)
  // Kills: the model answering after the hold ended
  const said = t.fake.state.messages.filter((m) => m.role === 'broker').map((m) => m.content)
  assert.deepEqual(said, [COVERED_LINE])
  await getThread(t.ids, { deps: t.deps })
  assert.equal(t.fake.state.messages.filter((m) => m.content === COVERED_LINE).length, 1)
  // Kills: the thread read saying "covered" a second time after the reply already said it
})

test('a conversation that never held the posting keeps the plain expired error', async () => {
  const t = setup({ expiresAt: minutesFromNow(-1) })
  const err = await sendMessage({ ...t.ids, text: 'hello' }, { deps: t.deps }).catch((e) => e)
  assert.equal(err.code, 'POSTING_EXPIRED')
})

// The three ways this bot got stuck in a loop, and what stops each.
//
// All of them are the same shape of mistake -- something that repeats
// with no reason to ever stop -- and none of them could be seen in a
// unit test before, because the loops lived in the entry point. Every
// dependency here is a fake: no token, no database, no network.
//
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryTick, pushDue, isPermanentSendFailure, chatAdvice } from '../src/bot/outgoing.js'
import { pollOnce, backoffMs, MAX_TURN_ATTEMPTS } from '../src/bot/loop.js'
import { handleUpdate } from '../src/bot/incoming.js'
import { EMPTY, newerPair, compareStamps, mergeState, claimOwnership } from '../src/bot/state.js'

const defer = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function update(id, over = {}) {
  return {
    update_id: id,
    message: {
      message_id: 100 + id,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 777, is_bot: false },
      text: `message ${id}`,
      ...over,
    },
  }
}

function telegramFake() {
  const said = []
  return {
    said,
    async getUpdates() { return [] },
    async sendMessage(chatId, text) { said.push(text); return { message_id: 9000 + said.length } },
  }
}

// -- 1. Two delivery passes at once --------------------------------------

// Kills: dropping the `running` guard. Without it setInterval starts a
// second pass while the first is still sleeping between sends, both read
// the same watermark, and the group gets the same driver reply twice --
// the duplicate that looked like a watermark bug and was not.
test('a delivery pass that is still running blocks the next tick', async () => {
  let started = 0
  const gate = defer()
  const tick = createDeliveryTick(async () => { started += 1; await gate.promise; return { sent: 1 } }, () => {})

  const first = tick()
  const second = await tick()

  assert.equal(started, 1, 'ikkinchi o\'tish birinchisi tugamasdan boshlandi')
  assert.deepEqual(second, { skipped: true })

  gate.resolve()
  await first
})

// Kills: releasing the guard after the await instead of in a finally. A
// pass that throws would leave the flag set forever: the bot keeps
// running, delivers nothing ever again, and says nothing about why.
test('a delivery pass that throws still lets the next one run', async () => {
  let started = 0
  const tick = createDeliveryTick(async () => { started += 1; throw new Error('database gone') }, () => {})

  await assert.rejects(() => tick())
  await assert.rejects(() => tick())

  assert.equal(started, 2, 'yiqilgan o\'tish qulfni qaytarmadi')
})

function appFor(driver, extra = {}) {
  const sent = []
  return {
    sent,
    app: {
      driversByName: async (name) => (name.toLowerCase() === driver.name.toLowerCase() ? [driver] : []),
      driversList: async () => [driver],
      driverById: async (id) => (id === driver.id ? driver : null),
      getCarrier: async () => ({ name: 'Keystone Line Haul' }),
      openConversation: async ({ driverId }) => ({ conversation: { id: `conv-${driverId}` } }),
      sendMessage: async (payload) => { sent.push(payload) },
      ...extra,
    },
  }
}

const MARCUS = { id: 'd4', name: 'Marcus Hale', dutyStatus: 'driving' }

// -- 2. One message retried forever --------------------------------------

// Kills: keeping a failing message with no limit. Nothing was written and
// nobody was answered, so keeping it is right -- for a while. Kept
// forever it is retried every few seconds for as long as the bot runs,
// and each retry can cost a model call.
test('a message the app cannot take is kept — and then given up on, out loud', async () => {
  const boom = () => { const err = new Error('the app is not answering'); err.status = 0; throw err }

  const broken = appFor(MARCUS, { sendMessage: boom }).app

  const early = telegramFake()
  early.getUpdates = async () => [update(1)]
  const savedEarly = []
  await assert.rejects(
    () => pollOnce({
      telegram: early, state: { ...EMPTY }, save: (s) => savedEarly.push(s),
      chatId: -100500, userId: 'u1', attempts: 0,
      app: broken, fixedDriverName: 'Marcus Hale',
    }),
    /not answering/,
  )
  assert.deepEqual(savedEarly, [], 'yetkazilmagan xabar o\'qilgan deb belgilandi')

  const late = telegramFake()
  late.getUpdates = async () => [update(1)]
  const savedLate = []
  await pollOnce({
    telegram: late, state: { ...EMPTY }, save: (s) => savedLate.push(s),
    chatId: -100500, userId: 'u1', attempts: MAX_TURN_ATTEMPTS,
    app: broken, fixedDriverName: 'Marcus Hale',
  })

  assert.equal(savedLate.length, 1, 'taslim bo\'lgandan keyin ham o\'qish joyi surilmadi')
  assert.equal(savedLate[0].offset, 2)
  assert.match(late.said.join('\n'), /could not deliver/i, 'guruhga hech narsa aytilmadi')
})

// Kills: a flat retry delay. Twelve identical lines a minute is not
// information; it is the same line twelve times.
test('the wait between tries grows, and stops growing', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n)), [5000, 10000, 20000, 40000, 60000, 60000])
})

// -- 3. One group, one driver --------------------------------------------

// Kills: treating the fixed driver as a default the routing can be
// talked out of. A reply to a line from BEFORE the group was narrowed to
// one driver still carries an old target id; honouring it puts the
// dispatcher's words in a driver they are no longer talking to, and
// nothing anywhere shows the mistake.
test('with one driver configured, even a reply to an old line goes to that driver', async () => {
  const { app, sent } = appFor(MARCUS)
  const state = { ...EMPTY, targets: { 555: 'd9-someone-else' }, currentDriverId: 'd9-someone-else' }

  const result = await handleUpdate(
    { chatId: '-100500', text: 'where are you', replyToTelegramMessageId: 555 },
    { state, app, userId: 'u1', fixedDriverName: 'Marcus Hale' },
  )

  assert.equal(sent.length, 1)
  assert.equal(sent[0].conversationId, 'conv-d4')
  assert.equal(result.state.currentDriverId, 'd4')
})

// Kills: leaving /d live next to a fixed driver. Two ways to choose who
// the group is talking to is one way too many, and the one that wins
// would be whichever was used last.
test('with one driver configured, /d does not change who the group talks to', async () => {
  const { app, sent } = appFor(MARCUS)

  const result = await handleUpdate(
    { chatId: '-100500', text: '/d Someone Else' },
    { state: { ...EMPTY }, app, userId: 'u1', fixedDriverName: 'Marcus Hale' },
  )

  assert.equal(sent.length, 0)
  assert.match(result.replies.join('\n'), /talks to Marcus Hale/)
  assert.equal(result.state.currentDriverId, null)
})

// Kills: resolving the name once at boot. A roster that changes under a
// running bot (the driver quit, the database was cleaned) must say so,
// not keep answering as a row that is no longer there.
test('a configured name that matches nobody says so instead of answering', async () => {
  const { app, sent } = appFor(MARCUS)

  const result = await handleUpdate(
    { chatId: '-100500', text: 'you there?' },
    { state: { ...EMPTY }, app, userId: 'u1', fixedDriverName: 'Someone Who Quit' },
  )

  assert.equal(sent.length, 0)
  assert.match(result.replies.join('\n'), /matches 0 drivers/)
})

// -- 4. A chat that will never take the message --------------------------

// Kills: treating every send failure as something that passes. This is
// the loop that actually happened, and the log is the whole proof:
// twenty identical lines, `Forbidden: bot was blocked by the user`, one
// every fifteen seconds, delivering nothing. A 403 is not "not right
// now", it is "not until a person does something", and the watermark
// standing still means the bot will keep trying that same message for
// as long as it runs.
test('a chat that blocked the bot is a permanent failure, a rate limit is not', () => {
  const forbidden = new Error('telegram sendMessage: Forbidden: bot was blocked by the user')
  forbidden.status = 403
  assert.equal(isPermanentSendFailure(forbidden), true)

  const gone = new Error('telegram sendMessage: Bad Request: chat not found')
  gone.status = 400
  assert.equal(isPermanentSendFailure(gone), true)

  const busy = new Error('telegram sendMessage: Too Many Requests: retry after 12')
  busy.status = 429
  assert.equal(isPermanentSendFailure(busy), false, 'rate limit abadiy xato deb o\'qildi')

  const down = new Error('telegram sendMessage: network error')
  down.status = 0
  assert.equal(isPermanentSendFailure(down), false, 'tarmoq uzilishi abadiy xato deb o\'qildi')

  // A 400 that is about the MESSAGE, not the chat: that one message is
  // bad, the chat is fine, and stopping the bot over it would be wrong.
  const tooLong = new Error('telegram sendMessage: Bad Request: message is too long')
  tooLong.status = 400
  assert.equal(isPermanentSendFailure(tooLong), false)
})

// Kills: swallowing the send failure inside pushDue, or advancing the
// watermark past a message that was never sent. Both would lose what the
// driver said -- silently, which is the one outcome this project does
// not allow.
test('a reply that could not be sent keeps its place in the queue', async () => {
  const rows = [{ id: 'm1', content: 'On my way', deliverAt: new Date('2026-09-29T12:00:00Z'), driverId: 'd4', driverName: 'Marcus Hale', truckId: 'TRK-104' }]
  const saved = []
  const telegram = {
    async sendMessage() { const err = new Error('Forbidden: bot was blocked by the user'); err.status = 403; throw err },
  }

  await assert.rejects(
    () => pushDue({
      state: { ...EMPTY }, chatId: -100500, userId: 'u1', telegram,
      save: (s) => saved.push(s), due: async () => rows, gapMs: 0,
    }),
    (err) => err.permanentChatFailure === true,
  )
  assert.deepEqual(saved, [], 'yuborilmagan javob yuborilgan deb belgilandi')
})

// Kills: printing Telegram's wording and stopping there. "Forbidden: bot
// was blocked by the user" says what happened and never what to do, and
// the thing to do is not in this program.
test('the advice names what a person has to do, not what Telegram said', () => {
  const forbidden = new Error('Forbidden'); forbidden.status = 403
  assert.match(chatAdvice(forbidden), /Unblock|add it again/i)

  const wrongId = new Error('chat not found'); wrongId.status = 400
  assert.match(chatAdvice(wrongId), /NEGATIVE/)
})

// -- 5. The watermark that could not move --------------------------------

// Kills: comparing two timestamps as text. This is the loop of
// 2026-09-29 evening -- forty copies of "Yeah, I'll stop here." in the
// group, one every fifteen seconds -- and the whole of it is one
// character. PostgreSQL stores microseconds; a JS Date holds
// milliseconds; the same instant therefore arrives as ".762385Z" or as
// ".762Z". As strings the SHORTER one wins, because at the fourth
// character it is 'Z' against '3'. So the merge kept the truncated
// value, the truncated value is genuinely less than the row it names,
// the query handed that row back as still due, and the bot sent it
// again. Forever.
test('a microsecond timestamp beats the millisecond one it was truncated from', () => {
  const truncated = ['2026-09-29T12:54:19.762Z', 'm1']
  const exact = ['2026-09-29T12:54:19.762385Z', 'm1']

  // Whichever way round they arrive.
  assert.equal(newerPair(exact, truncated)[0], exact[0])
  assert.equal(newerPair(truncated, exact)[0], exact[0])

  // And the ordinary case still orders by the instant, not the text.
  assert.equal(compareStamps('2026-09-29T12:54:19.762385Z', '2026-09-29T12:54:20.000000Z'), -1)
  assert.equal(compareStamps('2026-09-29T12:54:19.762385Z', '2026-09-29T12:54:19.762385Z'), 0)
  // ".9Z" is nine hundred milliseconds, not nine microseconds.
  assert.equal(compareStamps('2026-09-29T12:54:19.9Z', '2026-09-29T12:54:19.100000Z'), 1)
  // And the same instant written two ways is the SAME instant -- if it
  // compared as "different", the tie-break by message id would never
  // run, and two replies due in the same microsecond would order by
  // nothing at all.
  assert.equal(compareStamps('2026-09-29T12:54:19.762Z', '2026-09-29T12:54:19.762000Z'), 0)
  assert.equal(compareStamps('2026-09-29T12:54:19Z', '2026-09-29T12:54:19.000000Z'), 0)
})

// Kills: sending a row the query should have excluded. The comparison
// above is the cause that was found; this is the guard for the next one.
// A reply that comes back as due after it was sent means the watermark
// did not take -- and the answer to that is never to send it again.
test('a reply that comes back after being sent is corrected, not re-sent', async () => {
  const row = {
    id: 'm1', content: "Yeah, I'll stop here.",
    deliverAt: new Date('2026-09-29T12:54:19.762Z'),
    deliverAtText: '2026-09-29T12:54:19.762385Z',
    driverId: 'd4', driverName: 'Grace Lindqvist', truckId: 'TRK-104',
  }
  const saved = []
  const said = []
  const telegram = { async sendMessage(_chat, text) { said.push(text); return { message_id: 1 } } }

  const result = await pushDue({
    // The state a bot restarted with: the truncated watermark, naming
    // the very row the query hands back.
    state: { ...EMPTY, deliveredThrough: ['2026-09-29T12:54:19.762Z', 'm1'] },
    chatId: -100500, userId: 'u1', telegram,
    save: (s) => saved.push(s), due: async () => [row], gapMs: 0,
  })

  assert.deepEqual(said, [], 'yuborilgan javob yana yuborildi')
  assert.equal(result.sent, 0)
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].deliveredThrough, ['2026-09-29T12:54:19.762385Z', 'm1'])
})

// Kills: a guard that refuses to send anything. The correction above
// must not stop the replies that legitimately follow.
test('the reply after the corrected one still goes out', async () => {
  const rows = [
    { id: 'm1', content: 'old', deliverAtText: '2026-09-29T12:54:19.762385Z', driverId: 'd4', driverName: 'Grace Lindqvist', truckId: null },
    { id: 'm2', content: 'new', deliverAtText: '2026-09-29T12:55:00.100200Z', driverId: 'd4', driverName: 'Grace Lindqvist', truckId: null },
  ]
  const said = []
  const telegram = { async sendMessage(_chat, text) { said.push(text); return { message_id: said.length } } }

  const result = await pushDue({
    state: { ...EMPTY, deliveredThrough: ['2026-09-29T12:54:19.762Z', 'm1'] },
    chatId: -100500, userId: 'u1', telegram,
    save: () => {}, due: async () => rows, gapMs: 0,
  })

  assert.equal(result.sent, 1)
  assert.match(said.join('\n'), /new/)
  assert.deepEqual(result.state.deliveredThrough, ['2026-09-29T12:55:00.100200Z', 'm2'])
})

// -- 6. Two bots on one token --------------------------------------------

// Kills: starting a second bot next to one that is already running. This
// is the state the group was in for half an hour on 2026-09-29: the
// backend stopped, the terminal closed, and a node process nobody could
// see still writing to the group every fifteen seconds. The file it was
// writing did not say who was writing it.
test('a second bot refuses to start while the first is alive', () => {
  const state = { ...EMPTY, owner: { pid: 4242, startedAt: '2026-09-29T13:00:00.000Z' } }

  const blocked = claimOwnership(state, { pid: 9999, isAlive: () => true, fileAgeMs: 5000 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.owner.pid, 4242, 'to\'xtatish kerak bo\'lgan jarayon raqami aytilmadi')
})

// Kills: a lock with no way out. A pid is reused by the operating system
// and a crashed bot never clears its own signature, so a lock that
// trusts the pid alone eventually stops the bot from ever starting --
// and the fix for THAT is usually to delete the lock, which means
// nobody has a lock any more.
test('a bot takes over from an owner that is gone, or from a file nobody has touched', () => {
  const state = { ...EMPTY, owner: { pid: 4242, startedAt: '2026-09-29T13:00:00.000Z' } }

  const dead = claimOwnership(state, { pid: 9999, isAlive: () => false, fileAgeMs: 5000 })
  assert.equal(dead.ok, true)
  assert.equal(dead.tookOver.pid, 4242)

  // The pid answers -- but it was handed to something else, and this
  // file has not been written in an hour. No bot is that quiet.
  const reused = claimOwnership(state, { pid: 9999, isAlive: () => true, fileAgeMs: 3_600_000 })
  assert.equal(reused.ok, true)

  // Restarting as the same process is not a conflict with itself.
  assert.equal(claimOwnership(state, { pid: 4242, isAlive: () => true, fileAgeMs: 1000 }).ok, true)
  // And a file with no owner at all belongs to whoever asks.
  assert.equal(claimOwnership({ ...EMPTY }, { pid: 1, isAlive: () => true, fileAgeMs: 0 }).ok, true)
})

// Kills: letting an ordinary save wipe the signature. Both loops save
// without an `owner` field, every few seconds -- if the merge took the
// incoming value literally, the file would be unsigned again one tick
// after the bot started, and the lock would protect nothing.
test('the signature survives the saves that do not mention it', () => {
  const signed = mergeState({ ...EMPTY }, { owner: { pid: 7, startedAt: 'now' } })
  const after = mergeState(signed, { offset: 5 })
  assert.deepEqual(after.owner, { pid: 7, startedAt: 'now' })
})

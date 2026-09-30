// The other direction: what the driver said, carried to the group.
//
// The chat's delay model decides WHEN a driver answers (026's deliver_at,
// driverChat.replyTiming.js). This decides only HOW the answer leaves,
// and is deliberately too dumb to understand a word of what it carries.
//
// What is gone since 2026-09-29: the telegram_deliveries outbox and the
// cron job that drained it. The outbox existed so two processes could not
// send the same message twice -- the claim was taken by the database
// because neither process could trust the other's memory. One process
// has nobody to disagree with, so the read position is a watermark in
// its own state file, the same kind of fact as the poll offset. The cost
// is stated plainly: a crash between the send and the write replays one
// message. A replayed line is visible in the group; a lost one is not.

import { formatDriverMessage } from './format.js'
import * as repo from './bot.repository.js'
import { rememberTarget } from './state.js'
import config from '../config.js'

export const TICK_SEC = 15

// How much Telegram allows, and where that is written down.
// https://core.telegram.org/bots/faq (checked 2026-09-28): 20 messages a
// minute to one group, and no more than one a second to one chat.
export const RATE = Object.freeze({
  GROUP_MSG_PER_MIN: 20,
  MIN_GAP_MS: 1000,
})

// What the group cap allows in one tick (15s -> 5), not a number anyone
// picked. The per-chat one-a-second is honoured by the gap between sends.
export const PER_TICK = Math.floor((TICK_SEC / 60) * RATE.GROUP_MSG_PER_MIN)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Will this send ever work?
//
// On 2026-09-29 the answer was no, and the bot did not know how to ask.
// Telegram kept answering `Forbidden: bot was blocked by the user`; the
// send threw, the watermark stayed where it was, and fifteen seconds
// later the same reply was sent to the same chat that would never take
// it. That is the loop: not a message repeated to the group, a message
// repeated at a door that is shut.
//
// 403 is Telegram saying the door is shut -- blocked, kicked, removed
// from the group. 400 chat-not-found is the same fact with a different
// number: the id in .env is not a chat this bot can reach. Neither
// improves by waiting, and neither is about the MESSAGE, so giving up
// on the message would be wrong too: nothing can be delivered until a
// person changes something outside this program.
//
// 429 (too many requests) and the 5xx family are the opposite -- they
// are about right now -- so they keep the message and try again.
export function isPermanentSendFailure(err) {
  if (err?.status === 403) return true
  return err?.status === 400 && /chat not found|chat_id is empty|group chat was upgraded/i.test(err.message ?? '')
}

// How a driver's line is spelled for the chat. With no fixed driver the
// chat is a shared room and the prefix is the name on the door: several
// drivers answer, so every line says who. With TELEGRAM_DRIVER_NAME set
// the chat IS that one person -- a private conversation where a name on
// every text would be a machine's habit, not a person's.
export function lineFor({ driverName, truckId, content }) {
  const fixed = config.telegramDriverName
  if (fixed && driverName && driverName.trim().toLowerCase() === fixed.trim().toLowerCase()) {
    return content
  }
  return formatDriverMessage({ driverName, truckId, content })
}

// One pass. Returns the state to save -- the caller persists it, and
// persists it after every message rather than at the end of the tick,
// because the tick can be interrupted and the messages cannot be unsent.
export async function pushDue({ state, chatId, userId, telegram, save, due = repo.dueDriverMessages, gapMs = RATE.MIN_GAP_MS }) {
  const rows = await due({ userId, through: state.deliveredThrough, limit: PER_TICK })
  let next = state

  // The id of the last reply this bot sent, as the watermark records it.
  // The query is supposed to exclude exactly that row -- if it comes back
  // anyway, the watermark written for it did not describe it precisely
  // enough for PostgreSQL to agree, and sending it again is how one
  // reply becomes forty copies in a group.
  const alreadySent = state.deliveredThrough?.[1] ?? null
  let sentCount = 0

  for (const [index, row] of rows.entries()) {
    if (row.id === alreadySent) {
      // Not sent again. The watermark is rewritten from the row itself,
      // at the precision the database used, which is what should have
      // been stored the first time. Loud, because a correct watermark
      // never needs correcting: this line means a state file written by
      // an older build, or a new way of losing precision.
      console.error(`[bot] this reply was already sent but came back as due — correcting the watermark instead of re-sending (${row.id})`)
      next = { ...next, deliveredThrough: [row.deliverAtText ?? toIso(row.deliverAt), row.id] }
      save(next)
      continue
    }
    if (index > 0 && sentCount > 0) await sleep(gapMs)

    let sent
    // The typing indicator goes out first, best-effort: a person who is
    // "typing…" and then answers reads as a person; a reply that pops in
    // fully formed reads as a machine. The indicator lasts ~5s on
    // Telegram's side; the reply timing is 2-5 minutes, so a single call
    // here cannot bridge the whole wait -- it marks the moment the
    // driver picked the phone up, which is the part that reads as human.
    try {
      await telegram.sendChatAction?.(chatId, 'typing')
    } catch {
      // An indicator nobody saw is nothing lost; never fail a send for it.
    }
    try {
      sent = await telegram.sendMessage(
        chatId,
        lineFor({ driverName: row.driverName, truckId: row.truckId, content: row.content }),
      )
    } catch (err) {
      // Marked, not swallowed. The caller stops the bot on this one --
      // the watermark stays where it is, so nothing the driver said is
      // lost, and it all goes out when the chat is reachable again.
      if (isPermanentSendFailure(err)) err.permanentChatFailure = true
      throw err
    }

    // The reply map first, then the watermark: both are written in the
    // same save, and the order inside the object is the order a reader
    // of this file should think in. A line whose driver is forgotten can
    // still be replied to (the chat's current driver answers); a line
    // sent twice cannot be taken back.
    // A send with no message_id back is not a line anyone can reply to,
    // so there is nothing to remember about it -- but it WAS sent, and
    // the watermark moves either way.
    //
    // The watermark carries the timestamp AT FULL PRECISION
    // (deliverAtText, microsecond 'YYYY-MM-DD...SS.USZ' from the query),
    // never Date.toISOString(): JavaScript's Date truncates to
    // milliseconds, PostgreSQL keeps microseconds, and a watermark
    // rounded DOWN compares less than the row it names -- so that same
    // row came back as due on every tick and the reply was re-sent
    // forever (the 2026-09-29 live bug; three copies of one line).
    if (sent?.message_id) next = rememberTarget(next, sent.message_id, row.driverId)
    next = { ...next, deliveredThrough: [row.deliverAtText ?? toIso(row.deliverAt), row.id] }
    save(next)
    sentCount += 1
  }

  return { state: next, sent: sentCount }
}

// pg gives a Date for timestamptz; the state file holds JSON. The value
// goes back to PostgreSQL as $1::timestamptz, so the string has to be one
// PostgreSQL reads the same way it wrote it -- ISO 8601 with the offset.
function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value)
}

// The tick, with the one guard it cannot run without.
//
// setInterval does not wait. A pass that sends five replies sleeps four
// seconds between them by design (Telegram's one-a-second rule), and a
// slow database or a retried send pushes it past the fifteen-second
// interval -- at which point a SECOND pass starts while the first is
// still inside its loop. Both read `state.deliveredThrough` before
// either has finished advancing it, both get the same rows back, and
// the group sees the same driver reply twice. That is the duplicate
// nobody could explain on 2026-09-29: the watermark was not rewinding
// any more, it was being read twice before it moved.
//
// The old cron job had this guard (`let running = false`) and it was
// lost in the move to setInterval. It is here, as a function around the
// work, so a test can start two passes at once and prove the second one
// does not run.
export function createDeliveryTick(run, log = console.warn) {
  let running = false
  return async () => {
    if (running) {
      log('[bot] the previous delivery pass is still going — skipping this tick')
      return { skipped: true }
    }
    running = true
    try {
      return await run()
    } finally {
      // finally, not after the await: a pass that throws must not leave
      // the flag set, or the bot stops delivering anything for as long
      // as it runs and says nothing about why.
      running = false
    }
  }
}

// What a person can actually do about a chat the bot cannot talk to.
// Telegram's own wording says what happened and never what to do.
export function chatAdvice(err) {
  if (err?.status === 403) {
    return [
      '  Telegram says the door is shut. One of these is true:',
      '    - the bot was blocked (open the chat with it and press Start / Unblock)',
      '    - the bot was removed from the group (add it again)',
      '    - it is a group and privacy mode is on (BotFather → /setprivacy → Disable, then re-add)',
    ].join('\n')
  }
  return [
    '  Check TELEGRAM_CHAT_ID in .env. A group id is NEGATIVE (-100...);',
    '  a positive id is a private chat with one person.',
  ].join('\n')
}

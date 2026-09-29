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

// One pass. Returns the state to save -- the caller persists it, and
// persists it after every message rather than at the end of the tick,
// because the tick can be interrupted and the messages cannot be unsent.
export async function pushDue({ state, chatId, userId, telegram, save, due = repo.dueDriverMessages, gapMs = RATE.MIN_GAP_MS }) {
  const rows = await due({ userId, through: state.deliveredThrough, limit: PER_TICK })
  let next = state

  for (const [index, row] of rows.entries()) {
    if (index > 0) await sleep(gapMs)

    const sent = await telegram.sendMessage(
      chatId,
      formatDriverMessage({ driverName: row.driverName, truckId: row.truckId, content: row.content }),
    )

    // The reply map first, then the watermark: both are written in the
    // same save, and the order inside the object is the order a reader
    // of this file should think in. A line whose driver is forgotten can
    // still be replied to (the chat's current driver answers); a line
    // sent twice cannot be taken back.
    // A send with no message_id back is not a line anyone can reply to,
    // so there is nothing to remember about it -- but it WAS sent, and
    // the watermark moves either way.
    if (sent?.message_id) next = rememberTarget(next, sent.message_id, row.driverId)
    next = { ...next, deliveredThrough: [toIso(row.deliverAt), row.id] }
    save(next)
  }

  return { state: next, sent: rows.length }
}

// pg gives a Date for timestamptz; the state file holds JSON. The value
// goes back to PostgreSQL as $1::timestamptz, so the string has to be one
// PostgreSQL reads the same way it wrote it -- ISO 8601 with the offset.
function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value)
}

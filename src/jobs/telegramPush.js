// The outgoing job: everything the driver has "said" that the app owes
// the group, carried over within seconds.
//
// opsTick.js's pattern, on a faster clock -- 15s against 30s -- because
// this is a conversation: a reply that lands a minute after it was due
// reads as being ignored. The chat's own delay model (deliver_at, from
// driverChat.replyTiming.js) decides WHEN a message may leave; this job
// decides only HOW it leaves, and is deliberately too dumb to understand
// a single word of what it carries.
//
// One rule inherited from 046: the outbox row is created by the database
// deciding. claimDelivery returns a row only when THIS tick won it, so a
// second process -- or a second tick racing the first -- cannot send a
// message twice. "Already claimed" is checked in the same breath as the
// INSERT, not by reading first and deciding after.

import cron from 'node-cron'
import { pool } from '../db/pool.js'
import config from '../config.js'
import { createTelegramClient } from '../modules/telegram/telegram.client.js'
import { formatDriverMessage } from '../modules/telegram/telegram.format.js'
import * as repo from '../modules/telegram/telegram.repository.js'

export const TICK_SEC = 15

// How much Telegram allows, and where that is written down.
//
// https://core.telegram.org/bots/faq (2026-09-28): guruhga daqiqada 20
// xabar, bitta chatga sekundiga bittadan oshmasin.
export const RATE = Object.freeze({
  GROUP_MSG_PER_MIN: 20,
  MIN_GAP_MS: 1000,
})

// Per tick: what the group cap allows in one 15-second window (5), not a
// number anyone picked. The per-chat 1/sec is honoured by the GAP between
// consecutive sends inside the tick.
export const PER_TICK = Math.floor((TICK_SEC / 60) * RATE.GROUP_MSG_PER_MIN)

let running = false

// One message, end to end: claim, send, mark. Exported for the tests --
// the test passes a fake client and asserts on what it recorded, the
// same shape chargeInterest({ run }) asks for.
export async function pushOne({ messageId, chatId, driverName, truckId, content }, client = null, telegram = null) {
  const tg = telegram
    ?? createTelegramClient({ token: config.telegramToken })

  // The claim. No row back = another tick already owns it. The claim is
  // taken BEFORE the send and on the same connection as the mark, so a
  // crash can only ever land between the two, never double-send.
  const claimed = await repo.claimDelivery({ messageId, chatId }, client)
  if (!claimed) return { skipped: 'claimed elsewhere' }

  try {
    const sent = await tg.sendMessage(chatId, formatDriverMessage({ driverName, truckId, content }))
    await repo.markSent(messageId, sent?.message_id ?? null, client)
    return { sent: true }
  } catch (err) {
    // Counted, kept, retried later by the same scan -- the message is
    // never lost, only late. Five failures and the thread shows the
    // "not delivered" badge (stage 6); nothing is deleted.
    await repo.markFailed(messageId, String(err.message ?? err).slice(0, 500), client)
    return { failed: err.message }
  }
}

export async function pushOnce(reason = 'tick') {
  if (running) return { outcome: 'busy' }
  running = true
  try {
    const telegram = createTelegramClient({ token: config.telegramToken })

    // One pass = fresh messages still owed, then counted failures with
    // tries left. The retry scan deliberately EXCLUDES rows whose send
    // never reported anything: a row may be out on Telegram already, and
    // re-sending it makes the driver say everything twice. The cost of
    // leaving it is only that replies cannot route to it (046).
    const fresh = await repo.pendingMessages(PER_TICK)
    const retries = await repo.retryMessages(PER_TICK)
    const batch = [...fresh, ...retries].slice(0, PER_TICK)

    let sent = 0
    let failed = 0
    for (const message of batch) {
      const result = await pushOne(message, null, telegram)
      if (result.sent) sent += 1
      if (result.failed) failed += 1
      // The per-chat 1/sec rule, honoured by standing still between sends
      // rather than by a rate limiter nobody audits.
      await new Promise((resolve) => setTimeout(resolve, RATE.MIN_GAP_MS))
    }

    // Over the cap: the rest stays scanned-out and waits for the next
    // tick. A queue that drains late is honest; a burst that floods the
    // group is a rate-limit ban. (The same lesson MAX_CATCHUP_REAL_MS
    // teaches the seed generator: catch up slowly or not at all.)
    if (fresh.length + retries.length > PER_TICK) {
      console.log(`[telegramPush] ${fresh.length + retries.length} owed, ${batch.length} sent this tick, rest next tick (${reason})`)
    }
    if (sent > 0 || failed > 0) {
      console.log(`[telegramPush] ${sent} sent, ${failed} failed (${reason})`)
    }
    return { outcome: 'ran', sent, failed, owed: fresh.length + retries.length }
  } catch (err) {
    // Never let a bridge failure take the process down -- the next tick
    // is fifteen seconds away and every step is idempotent.
    console.error(`[telegramPush] failed (${reason}): ${err.message}`)
    return { outcome: 'failed', error: err.message }
  } finally {
    running = false
  }
}

export function startTelegramPush() {
  if (!config.telegramEnabled) {
    console.log('[telegramPush] TELEGRAM_BOT_TOKEN empty — outgoing bridge off')
    return
  }
  cron.schedule(`*/${TICK_SEC} * * * * *`, () => pushOnce('cron'))
  pushOnce('startup')
  console.log(`[telegramPush] scheduled every ${TICK_SEC}s — up to ${PER_TICK} messages per tick, min ${RATE.MIN_GAP_MS}ms apart`)
}

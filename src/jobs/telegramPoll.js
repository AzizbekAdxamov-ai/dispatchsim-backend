// The incoming half of the bridge: long-poll Telegram for what the group
// typed, and hand each message to the bridge for resolution.
//
// Shape: the same loop-forever pattern as the push job, on its own
// schedule -- getUpdates holds the connection up to 25 seconds, so this
// is an async loop with its own error recovery rather than a cron tick.
// The offset is the ONLY state it keeps, and it lives in sim_state, so a
// restart resumes instead of replaying yesterday into the threads.
//
// The bot's own messages and other bots' posts are ignored (their
// from.is_bot is true): a bridge that answers itself loops forever.

import { pool } from '../db/pool.js'
import config from '../config.js'
import { createTelegramClient } from '../modules/telegram/telegram.client.js'
import * as repo from '../modules/telegram/telegram.repository.js'
import { handleUpdate, resetNoticeCache } from '../modules/telegram/telegram.bridge.js'

const LONG_POLL_SEC = 25
const ERROR_BACKOFF_MS = 5000

let running = false
let loopActive = false

// One update, flattened to the facts the bridge needs. Returns null for
// everything that is not a plain text message from a person.
function toFacts(update) {
  const message = update.message ?? update.channel_post ?? null
  if (!message?.text) return null
  // is_bot: other bots' posts (and the bot's own sends echoed back in
  // groups) never become messages to drivers.
  if (message.from?.is_bot) return null
  return {
    chatId: String(message.chat.id),
    text: message.text,
    fromTgUserId: message.from?.id ?? null,
    // reply_to_message exists only when someone actually replied.
    replyToTelegramMessageId: message.reply_to_message?.message_id ?? null,
  }
}

async function processUpdates(updates, telegram) {
  for (const update of updates) {
    // Offset bookkeeping FIRST: whatever happens below, a crash must not
    // replay this update. At-least-once with bridge-side idempotency is
    // the honest contract here, not exactly-once.
    await repo.setPollOffset(update.update_id + 1)
    const facts = toFacts(update)
    if (!facts) continue

    // The optional allow-list: a lock, not a feature. An unlisted chat
    // gets the same silence the bridge gives everything else it ignores.
    if (config.telegramAllowedChatIds.length > 0 && !config.telegramAllowedChatIds.includes(Number(facts.chatId))) {
      continue
    }

    try {
      await handleUpdate(facts, telegram)
    } catch (err) {
      // One bad update must not stop the group's messages. The offset
      // has already moved, so it is logged and left behind -- a loop
      // that dies on one poison update dies forever.
      console.error(`[telegramPoll] update ${update.update_id} failed: ${err.message}`)
    }
  }
}

export async function pollOnce(telegram = null) {
  const tg = telegram ?? createTelegramClient({ token: config.telegramToken })
  const offset = await repo.getPollOffset()
  // Long poll: Telegram holds the request until something arrives or the
  // timeout passes -- cheap when idle, instant when busy.
  const updates = await tg.getUpdates(offset, LONG_POLL_SEC)
  await processUpdates(updates, tg)
  return { count: updates.length }
}

export function startTelegramPoll() {
  if (!config.telegramEnabled) {
    console.log('[telegramPoll] TELEGRAM_BOT_TOKEN empty — incoming bridge off')
    return
  }
  if (config.telegramMode !== 'poll') {
    // Webhook mode listens for pushes instead of pulling; a deployment
    // that selects it must not have this loop racing it for updates.
    console.log(`[telegramPoll] mode ${config.telegramMode} — poll loop off`)
    return
  }

  if (loopActive) return
  loopActive = true
  running = true
  ;(async () => {
    resetNoticeCache()
    try {
      while (running) {
        try {
          await pollOnce()
        } catch (err) {
          // Network down, 409 from a second poller, Telegram 5xx: back
          // off and try again. The bridge is a convenience layer; it
          // fails loudly here and never takes the app down.
          console.error(`[telegramPoll] ${err.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`)
          await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS))
        }
      }
    } finally {
      loopActive = false
    }
  })()

  console.log(`[telegramPoll] long-polling every ${LONG_POLL_SEC}s window, offset in sim_state`)
}

export function stopTelegramPoll() {
  running = false
}

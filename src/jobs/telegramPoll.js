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
import { collectPhotos } from '../modules/telegram/telegram.vision.js'

const LONG_POLL_SEC = 25
const ERROR_BACKOFF_MS = 5000

let running = false
let loopActive = false

// One update, flattened to the facts the bridge needs. Returns null for
// everything that is not a plain text message (or a photo) from a person.
function toFacts(update) {
  const message = update.message ?? update.channel_post ?? null
  if (!message) return null
  // is_bot: other bots' posts (and the bot's own sends echoed back in
  // groups) never become messages to drivers.
  if (message.from?.is_bot) return null

  const hasText = typeof message.text === 'string' && message.text !== ''
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0
  if (!hasText && !hasPhoto) return null
  if (hasPhoto && message.chat?.type !== 'private' && !hasText) {
    // A bare photo in the group with no caption and no reply context has
    // no addressee; the bridge's ask-who would just bounce it. Handled
    // below through collectPhotos only when aimed at someone.
  }
  return {
    chatId: String(message.chat.id),
    chatType: message.chat?.type ?? null,
    text: message.text ?? message.caption ?? '',
    fromTgUserId: message.from?.id ?? null,
    // reply_to_message exists only when someone actually replied.
    replyToTelegramMessageId: message.reply_to_message?.message_id ?? null,
    photoSizes: hasPhoto ? message.photo : null,
    mediaGroupId: message.media_group_id ?? null,
  }
}

async function processUpdates(updates, telegram) {
  // Telegram delivers an album as several consecutive updates sharing a
  // media_group_id; they are folded into ONE fact with all photos, so the
  // captioned album arrives as one turn, not five.
  const facts = []
  const groups = new Map()
  for (const update of updates) {
    // Offset bookkeeping FIRST: whatever happens below, a crash must not
    // replay this update. At-least-once with bridge-side idempotency is
    // the honest contract here, not exactly-once.
    await repo.setPollOffset(update.update_id + 1)
    const fact = toFacts(update)
    if (!fact) continue

    // The optional allow-list: a lock, not a feature. An unlisted chat
    // gets the same silence the bridge gives everything else it ignores.
    if (config.telegramAllowedChatIds.length > 0 && !config.telegramAllowedChatIds.includes(Number(fact.chatId))) {
      continue
    }

    if (fact.mediaGroupId) {
      const group = groups.get(fact.mediaGroupId) ?? { ...fact, photos: [] }
      if (fact.photoSizes) {
        const best = fact.photoSizes[fact.photoSizes.length - 1]
        group.photos.push({ fileId: best.file_id, width: best.width, height: best.height })
      }
      if (fact.text) group.text = fact.text
      groups.set(fact.mediaGroupId, group)
    } else {
      if (fact.photoSizes) {
        const best = fact.photoSizes[fact.photoSizes.length - 1]
        fact.photos = [{ fileId: best.file_id, width: best.width, height: best.height }]
      }
      facts.push(fact)
    }
  }
  facts.push(...groups.values())

  for (const fact of facts) {
    try {
      await handleUpdate(fact, telegram)
    } catch (err) {
      // One bad update must not stop the group's messages. The offset
      // has already moved, so it is logged and left behind -- a loop
      // that dies on one poison update dies forever.
      console.error(`[telegramPoll] update failed: ${err.message}`)
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

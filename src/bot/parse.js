// What Telegram sent, as facts -- and nothing more.
//
// This is the only thinking the bot does, and it is all mechanical: which
// updates belong together, which are messages at all, where the words
// are. Every decision that needs to know about drivers, threads, budgets
// or photos belongs to the backend, which has the database.
//
// Pure functions, no network, no clock.
//
// (This module and telegram.js came from the separate telegram_bot
// process on 2026-09-29, unchanged. The process is gone -- the bot runs
// inside this app now, with the database and the model client it needed
// an HTTP hop to reach -- but what Telegram sends and how it is parsed
// did not change with it, and neither did their tests.)

// One batch of raw updates -> the photos in it and the caption that came
// with them.
//
// Telegram delivers an album as SEVERAL updates sharing one
// media_group_id, each carrying one photo, and the caption rides one of
// them (usually the first). The FIRST caption wins: the others carry
// none, and picking the last would mean the dispatcher's words change
// depending on which part arrived last.
export function collectPhotos(updates) {
  const photos = []
  let caption = null
  for (const update of updates) {
    const message = update.message ?? null
    const sizes = message?.photo
    if (Array.isArray(sizes) && sizes.length > 0) {
      // The largest size is the useful one; file_id is what getFile takes.
      const best = sizes[sizes.length - 1]
      photos.push({ fileId: best.file_id, width: best.width, height: best.height })
    }
    if (caption === null && typeof message?.caption === 'string' && message.caption.trim() !== '') {
      caption = message.caption.trim()
    }
  }
  return { photos, caption }
}

// One update, flattened. Returns null for everything that is not a
// message a person typed: joins, stickers, locations, and -- importantly
// -- anything from a bot, including this bot's own lines echoed back in
// a group. A bridge that answers itself loops forever, and every loop
// costs a model call.
export function toFacts(update) {
  const message = update?.message ?? update?.channel_post ?? null
  if (!message) return null
  if (message.from?.is_bot) return null

  const hasText = typeof message.text === 'string' && message.text !== ''
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0
  if (!hasText && !hasPhoto) return null

  return {
    chatId: String(message.chat.id),
    chatType: message.chat?.type ?? null,
    // `text` only. A photo's words live in `caption`, and that is
    // collectPhotos' business -- read in both places, the caption would
    // have two owners and neither could be tested: whichever one broke,
    // the other would quietly cover for it.
    text: message.text ?? '',
    fromTgUserId: message.from?.id ?? null,
    // reply_to_message exists only when someone actually replied.
    replyToTelegramMessageId: message.reply_to_message?.message_id ?? null,
    // Who wrote the message being replied to. In a group with two people
    // in it, a reply to the OTHER PERSON is part of their conversation,
    // not something for the driver (src/bot/addressing.js).
    replyToFromBot: message.reply_to_message?.from?.is_bot === true,
    replyToUsername: message.reply_to_message?.from?.username ?? null,
  }
}

// A batch (one message, or one album) -> the single fact the backend gets.
export function factsForBatch(batch) {
  const base = toFacts(batch[0])
  if (!base) return null
  const { photos, caption } = collectPhotos(batch)
  if (photos.length > 0) base.photos = photos
  // The caption is the photo turn's text.
  if (!base.text && caption) base.text = caption
  return base
}

// Updates -> batches, keeping the order the group typed them in. An album
// is one batch; everything else is a batch of one.
export function batchUpdates(updates) {
  const groups = new Map()
  const batches = []
  for (const update of updates) {
    const message = update.message ?? update.channel_post ?? null
    const groupId = message?.media_group_id ?? null
    if (!groupId) {
      batches.push([update])
      continue
    }
    const existing = groups.get(groupId)
    if (existing) {
      existing.push(update)
    } else {
      const batch = [update]
      groups.set(groupId, batch)
      // Pushed now, filled as its other parts arrive: the album keeps its
      // place among the messages around it.
      batches.push(batch)
    }
  }
  return batches
}

// The highest update_id in a batch -- the offset moves past all of it, so
// a restart does not re-read half an album.
export function lastUpdateId(batch) {
  return Math.max(...batch.map((update) => update.update_id))
}

// The incoming loop, away from the entry point.
//
// index.js runs the bot the moment it is imported -- that is what an
// entry point is for -- so everything a test needs to call lives here
// instead. Every dependency arrives as an argument: no token, no
// database and no network is reachable from this file on its own.

import { batchUpdates, factsForBatch, lastUpdateId } from './parse.js'
import { handleUpdate } from './incoming.js'

export const POLL_TIMEOUT_SEC = 50

// How many photos of one album travel with a turn, and how big each may
// be. Both are this bot's choice, not a Telegram limit: a turn carries
// the picture someone meant to show, and thirty of them at four
// megabytes each is a request nobody wants to send, receive or pay for.
const MAX_PHOTOS_PER_TURN = 4
const MAX_PHOTO_BYTES = 4 * 1024 * 1024

async function attachPhotos(fact, telegram) {
  const wanted = fact.photos.slice(0, MAX_PHOTOS_PER_TURN)
  const attached = []
  for (const photo of wanted) {
    try {
      const file = await telegram.getFile(photo.fileId)
      if (file.file_size && file.file_size > MAX_PHOTO_BYTES) {
        attached.push({ fileId: photo.fileId, skipped: 'too large' })
        continue
      }
      const bytes = await telegram.downloadFile(file.file_path)
      attached.push({ fileId: photo.fileId, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` })
    } catch (err) {
      // Named, not swallowed: the turn carries the fact that the picture
      // did not arrive, and the group is told rather than the model
      // being asked to answer as if it had seen something.
      attached.push({ fileId: photo.fileId, skipped: err.message })
    }
  }
  fact.photos = attached
}

// Is this failure worth keeping the message for?
//
// A turn the app REFUSED is refused just as hard in five seconds, and
// replaying it would stop the group over one message. A turn that never
// reached the model or the database is a different fact: nothing was
// recorded and nothing was charged, so the dispatcher's words are still
// worth delivering once the other side is back.
export function isTransient(err) {
  return err?.status === 0 || err?.status >= 500 || err?.code === 'ECONNREFUSED' || err?.code === 'CHAT_UNAVAILABLE'
}

export async function pollOnce({ telegram, state, save, userId, chatId, vision, app = undefined }) {
  const updates = await telegram.getUpdates(state.offset, POLL_TIMEOUT_SEC)
  let next = state

  for (const batch of batchUpdates(updates)) {
    const fact = factsForBatch(batch)
    // Not this group: the bot sits in one group by configuration, and a
    // stranger adding it to another one must not reach this company's
    // drivers. Read past, never answered.
    if (fact && String(fact.chatId) !== String(chatId)) {
      console.warn(`[bot] ignoring a message from chat ${fact.chatId}`)
    } else if (fact) {
      if (fact.photos?.length > 0) await attachPhotos(fact, telegram)
      try {
        const result = await handleUpdate(fact, { state: next, userId, vision, ...(app ? { app } : {}) })
        next = result.state
        for (const line of result.replies) {
          await telegram.sendMessage(chatId, line)
        }
      } catch (err) {
        if (isTransient(err)) {
          // The read position does NOT move: nobody has been answered
          // and nothing was written. Throwing hands the wait to the
          // loop, which comes back to this same message.
          console.error(`[bot] turn not delivered, keeping it: ${err.message}`)
          throw err
        }
        console.error(`[bot] turn failed: ${err.message}`)
      }
    }

    // After the turn, never before. The other order is at-most-once: a
    // process that dies in between loses what the dispatcher just typed,
    // invisibly.
    next = { ...next, offset: lastUpdateId(batch) + 1 }
    save(next)
  }

  return next
}

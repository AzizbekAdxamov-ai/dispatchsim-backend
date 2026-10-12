// The incoming loop, away from the entry point.
//
// index.js runs the bot the moment it is imported -- that is what an
// entry point is for -- so everything a test needs to call lives here
// instead. Every dependency arrives as an argument: no token, no
// database and no network is reachable from this file on its own.

import { batchUpdates, factsForBatch, lastUpdateId } from './parse.js'
import { handleUpdate } from './incoming.js'
import { addressedToDriver, callName } from './addressing.js'

export const POLL_TIMEOUT_SEC = 50

// How many times one message may be re-tried before the bot stops
// re-trying it.
//
// Keeping a message that never reached the app is right (nothing was
// written, nobody was answered -- see isTransient below). Keeping it
// FOREVER is not: a turn that fails the same way every time is retried
// every five seconds, for as long as the bot runs, and each retry can
// cost a model call. The wall of identical lines says the same thing
// forever without ever saying what to do.
//
// Three tries, then the group is told plainly and the bot reads past it.
// Consequence over blocking: one message is lost visibly instead of the
// conversation stopping invisibly.
export const MAX_TURN_ATTEMPTS = 3

const ERROR_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 60_000

// Five seconds, then ten, then twenty, then a minute and no longer. The
// flat five-second retry was honest about failing and useless about it:
// twelve identical lines a minute, none of them new information.
export function backoffMs(attempts, base = ERROR_BACKOFF_MS, max = MAX_BACKOFF_MS) {
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max)
}

// How many photos of one album travel with a turn, and how big each may
// be. Both are this bot's choice, not a Telegram limit: a turn carries
// the picture someone meant to show, and thirty of them at four
// megabytes each is a request nobody wants to send, receive or pay for.
const MAX_PHOTOS_PER_TURN = 4
const MAX_PHOTO_BYTES = 4 * 1024 * 1024

// A line the INFRASTRUCTURE says -- provider limits, unreachable
// providers, photo notices, help and /status output. Prefixed so it can
// never be mistaken for the driver's own words: when the persona is a
// single fixed driver in a private chat, a bare "The chat provider is
// not answering" would sit in the thread as if Grace had said it, and
// the one way to break a character is to make it say things a person
// would not. The prefix is the seam between the road and the office.
export function systemLine(text) {
  return `[system] ${text}`
}

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

export async function pollOnce({
  telegram, state, save, userId, chatId, vision,
  fixedDriverName = null, app = undefined,
  // The bot's own @handle (getMe at boot). Lets a group reach it by
  // mention and tells its commands from another bot's.
  botUsername = null,
  // How many times the loop has already come back to this same message.
  // index.js counts; pollOnce decides what the count means.
  attempts = 0,
}) {
  const updates = await telegram.getUpdates(state.offset, POLL_TIMEOUT_SEC)
  let next = state

  for (const batch of batchUpdates(updates)) {
    const fact = factsForBatch(batch)
    // Not this group: the bot sits in one group by configuration, and a
    // stranger adding it to another one must not reach this company's
    // drivers. Read past, never answered.
    if (fact && String(fact.chatId) !== String(chatId)) {
      console.warn(`[bot] ignoring a message from chat ${fact.chatId}`)
    } else if (fact && !addressedToDriver(fact, { botUsername, driverName: fixedDriverName })) {
      // The people in the group talking to each other. Read past, not
      // answered and not charged -- and said in the log, so a message
      // that WAS meant for the driver and did not reach her has a line
      // somewhere naming why.
      const who = callName(fixedDriverName)
      console.log(`[bot] group talk, not addressed to ${who ?? 'the bot'} — left alone (reply to the bot${who ? `, or say "${who}"` : ''} to reach ${who ?? 'a driver'})`)
    } else if (fact) {
      if (fact.photos?.length > 0) await attachPhotos(fact, telegram)
      try {
        const result = await handleUpdate(fact, {
          state: next, userId, vision, fixedDriverName, botUsername, ...(app ? { app } : {}),
        })
        next = result.state
        for (const line of result.replies) {
          await telegram.sendMessage(chatId, systemLine(line))
        }
      } catch (err) {
        if (isTransient(err) && attempts < MAX_TURN_ATTEMPTS) {
          // The read position does NOT move: nobody has been answered
          // and nothing was written. Throwing hands the wait to the
          // loop, which comes back to this same message.
          console.error(`[bot] turn not delivered, keeping it: ${err.message}`)
          throw err
        }
        if (isTransient(err)) {
          // Tried enough. The message is given up on OUT LOUD -- in the
          // group, where the person who typed it is -- and then read
          // past, so one unanswerable message cannot hold the whole
          // conversation behind it.
          console.error(`[bot] giving up on a turn after ${attempts} tries: ${err.message}`)
          await telegram.sendMessage(chatId, systemLine(`I could not deliver that message (${err.message}). Send it again when the app is back.`))
        } else {
          console.error(`[bot] turn failed: ${err.message}`)
        }
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

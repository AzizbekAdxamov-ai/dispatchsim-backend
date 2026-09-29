// The bot's own bookkeeping: where it has read to, who the chat is
// talking to, and which of its own messages named which driver.
//
// A JSON file, not a table. Three of these four facts used to live in
// PostgreSQL (telegram_links.current_driver_id, the poll offset,
// telegram_deliveries as the reply map) because two processes had to
// agree on them. One process does not have to agree with anybody. What
// is left is the same class of fact as a terminal's scrollback position:
// the bot's, small, and worthless to the company.
//
// Written through a temporary file and renamed, so a crash mid-write
// cannot leave half a number behind.

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.bot-state.json')

// How many of the bot's own messages stay resolvable as reply targets.
// Telegram lets anyone reply to a message from any point in the group's
// history; this is the bot's memory of which driver each line came from.
// Past this many, a reply falls back to the chat's current driver -- the
// same answer someone gets who never replied to anything.
const MAX_TARGETS = 400

export const EMPTY = Object.freeze({
  offset: 0,
  currentDriverId: null,
  // The high-water mark of what has been pushed to the group, as
  // [deliver_at, message id]. A pair, not a timestamp: two messages can
  // become due in the same millisecond and a timestamp alone would skip
  // the second one forever.
  deliveredThrough: null,
  targets: {},
})

export function readState(file = FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...EMPTY, ...parsed, targets: parsed.targets ?? {} }
  } catch {
    // No file yet, or a file someone edited into nonsense. Starting from
    // empty re-reads whatever Telegram still has queued and re-asks which
    // driver -- annoying, visible, and not a lie about what was read.
    return { ...EMPTY }
  }
}

export function writeState(next, file = FILE) {
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2))
    renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.error(`[bot] could not save state: ${err.message}`)
  }
}

// Remember that a line the bot just sent belongs to a driver, and forget
// the oldest once there are too many. Pure: state in, state out.
export function rememberTarget(state, telegramMessageId, driverId, max = MAX_TARGETS) {
  const targets = { ...state.targets, [String(telegramMessageId)]: driverId }
  const keys = Object.keys(targets)
  if (keys.length > max) {
    // Telegram's message ids rise within a chat, so the numerically
    // smallest keys are the oldest lines.
    const oldest = keys.map(Number).sort((a, b) => a - b).slice(0, keys.length - max)
    for (const key of oldest) delete targets[String(key)]
  }
  return { ...state, targets }
}

export function targetFor(state, telegramMessageId) {
  return state.targets[String(telegramMessageId)] ?? null
}

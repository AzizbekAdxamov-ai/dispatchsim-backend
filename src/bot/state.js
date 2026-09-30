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

import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
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
  // Which process is writing this file, and since when. Not bookkeeping
  // the bot needs -- bookkeeping a PERSON needs. On 2026-09-29 Azizbek
  // stopped the backend and the bot and the group kept filling up: a
  // node process had outlived the window it was started from, and
  // nothing anywhere said which one it was. This file was being written
  // every fifteen seconds by something with no name and no face.
  owner: null,
  offset: 0,
  currentDriverId: null,
  // The high-water mark of what has been pushed to the group, as
  // [deliver_at, message id]. A pair, not a timestamp: two messages can
  // become due in the same millisecond and a timestamp alone would skip
  // the second one forever.
  deliveredThrough: null,
  targets: {},
})

// How long ago the state file was last written, in milliseconds. A
// missing file is infinitely old: nobody owns it.
export function stateFileAgeMs(file = FILE) {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

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

// Two timestamps from PostgreSQL, compared as instants rather than as
// text.
//
// This is where the repeating reply of 2026-09-29 evening came from, and
// the whole bug is one character. The same moment reaches this file in
// two shapes: three fractional digits when it came through a JS Date
// (pg parses timestamptz into one, and a Date holds milliseconds), six
// when it came from the query's to_char (PostgreSQL stores
// microseconds). Compared as strings, ".762385Z" is LESS than ".762Z" --
// at the fourth character it is '3' against 'Z', and '3' sorts first.
//
// So every tick did this: the query returned the reply (the stored
// .762385 is genuinely greater than the .762 in the watermark), the bot
// sent it, wrote back the exact .762385, and the merge threw that away
// and kept .762 because it looked bigger. Same reply, every fifteen
// seconds, for as long as the bot ran.
//
// Parse first: to the millisecond, both are the same instant, so the
// fractional digits decide, padded to the same width. Text comparison
// of timestamps is a trap whatever the format looks like today.
export function compareStamps(a, b) {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    // Not a timestamp either of us understands. Falling back to text is
    // the old behaviour, and the old behaviour is what this function
    // exists to replace -- so say so rather than compare quietly.
    console.error(`[bot] a watermark that is not a timestamp: ${a} / ${b}`)
    return String(a) === String(b) ? 0 : (String(a) < String(b) ? -1 : 1)
  }
  if (ta !== tb) return ta < tb ? -1 : 1
  const fa = fraction(a)
  const fb = fraction(b)
  return fa === fb ? 0 : (fa < fb ? -1 : 1)
}

// The fractional seconds, padded so three digits and six compare as the
// numbers they are: "762" is .762000, not .000762.
function fraction(iso) {
  const match = /[.,](\d+)/.exec(String(iso))
  return match ? match[1].slice(0, 6).padEnd(6, '0') : '000000'
}

// The delivered watermark is a [deliver_at, id] pair, and it must only
// ever move forward: rewinding it re-sends replies the group already
// saw (the bug of 2026-09-29 afternoon, when a poll's stale snapshot was
// assigned back over a tick's progress). A pair with no timestamp yet is
// never newer than an existing one. A timestamp tie is broken by id,
// larger wins -- the same order the due-query scans in (ORDER BY
// deliver_at, id), so a tie can never step the watermark past a reply
// the query would still return.
export function newerPair(a, b) {
  if (!a?.[0]) return b ?? null
  if (!b?.[0]) return a ?? null
  const order = compareStamps(a[0], b[0])
  if (order !== 0) return order > 0 ? a : b
  return String(a[1]) >= String(b[1]) ? a : b
}

// Merge an incoming write into the current state, field by field, with
// every field allowed only to move forward. This is the whole fix for
// the same live bug: pollOnce parks inside a 50-second long-poll holding
// the state it was handed, the outgoing tick advances the watermark
// meanwhile, and the poll's next write is based on a view that predates
// that advance. Plain assignment rewinds; this merge cannot.
//
//   offset            -- read position, only rises
//   deliveredThrough  -- the sent-replies watermark, only advances
//   currentDriverId   -- a stale null must not unselect the driver
//   targets           -- per-message-id facts, unioned, never wiped
//   owner             -- nothing to do: `...current` carries the
//                        signature through every save that does not
//                        mention it, which is all of them but the first.
//                        A line here would have been a second way to say
//                        the same thing, and a test proved it earned
//                        nothing (botLoop: the signature survives).
//
// Everything else (fields added tomorrow) takes the incoming value, so
// a new field's writer still owns it.
export function mergeState(current, incoming) {
  return {
    ...current,
    ...incoming,
    offset: Math.max(current.offset ?? 0, incoming.offset ?? 0),
    deliveredThrough: newerPair(incoming.deliveredThrough, current.deliveredThrough),
    currentDriverId: incoming.currentDriverId ?? current.currentDriverId ?? null,
    targets: { ...current.targets, ...incoming.targets },
  }
}

// How long a state file may sit unwritten before its owner is presumed
// gone. Two ticks and a bit: a live bot rewrites this far more often.
const OWNER_STALE_MS = 40_000

// May this process take the bot over?
//
// A pid alone is not proof -- pids are reused, and a stale one would
// stop the bot from ever starting again. So both have to hold: the
// recorded pid answers to a signal, AND the file has been written
// recently enough that it can only have been written by a live bot.
//
// Pure, with the two facts it cannot find out for itself handed in, so
// the decision can be tested without spawning anything.
export function claimOwnership(state, { pid, isAlive, fileAgeMs, staleMs = OWNER_STALE_MS }) {
  const owner = state.owner
  if (!owner || owner.pid === pid) return { ok: true }
  if (fileAgeMs > staleMs) return { ok: true, tookOver: owner }
  if (!isAlive(owner.pid)) return { ok: true, tookOver: owner }
  return { ok: false, owner }
}

// Is there a process with this id? `signal 0` asks without sending
// anything, on Windows as well as everywhere else. EPERM means the
// process exists and belongs to somebody else -- which still counts as
// alive, and is the answer that matters here.
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

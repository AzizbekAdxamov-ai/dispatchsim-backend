// Fast replies: the whole wait for an answer inside one minute.
//
// Azizbek, 2026-10-01, for a day of live testing with a second person:
// "broker and bot -- one minute at most, today only." CHAT_FAST_REPLIES=on
// turns it on (config.js); removing the line tomorrow turns it off. The
// normal delays are not a defect to be tuned away -- they are the job --
// so this is a switch, not a new setting for the numbers.
//
// The delays are COMPRESSED, not cut. Capping every wait at sixty would
// make an A broker and a D broker answer at the same second and erase the
// one thing the timing teaches (who is quick, who goes quiet). Instead
// each table's own range is squeezed into [FAST_FLOOR_SEC, cap]: the
// order survives -- A before D, the quiet broker and the driver with no
// signal still last -- and nothing goes past the minute.

import { TICK_SEC, TYPING_SHOWN_MS } from '../bot/outgoing.js'

// The promise: from the message sent to the answer on screen.
export const FAST_END_TO_END_SEC = 60

// Nobody answers in under five seconds. Not a sourced number -- a floor
// so that "fast" still reads as a person typing, and named as a choice.
export const FAST_FLOOR_SEC = 5

// What sits between "the reply is due" and "the reply is seen", for each
// door. The cap for the delay itself is the minute minus that.
//
// Broker: the open thread is re-read every 6 s
// (frontend/src/pages/BrokerChat.jsx, useResource(fetchThread, ..., { pollMs: 6000 })).
// Driver: the bot's delivery tick plus the "typing…" it shows first
// (src/bot/outgoing.js TICK_SEC and TYPING_SHOWN_MS -- imported, not
// copied, so changing either one moves this cap with it).
export const BROKER_THREAD_POLL_SEC = 6
export const BROKER_FAST_CAP_SEC = FAST_END_TO_END_SEC - BROKER_THREAD_POLL_SEC
export const DRIVER_FAST_CAP_SEC = FAST_END_TO_END_SEC - TICK_SEC - Math.ceil(TYPING_SHOWN_MS / 1000)

// The span every [lo, hi] in a delay table covers, lowest low to highest
// high -- the range that gets squeezed.
export function tableSpan(...ranges) {
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]
}

// One delay, moved from [min, max] to [floor, cap] in proportion. Pure.
export function compressDelay(sec, [min, max], cap, floor = FAST_FLOOR_SEC) {
  if (!(max > min)) return Math.max(floor, Math.min(cap, sec))
  const f = (Math.min(Math.max(sec, min), max) - min) / (max - min)
  return Math.round(floor + f * (cap - floor))
}

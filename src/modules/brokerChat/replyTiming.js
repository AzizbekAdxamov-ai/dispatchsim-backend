// How long a broker takes to answer, and whether the paper matches the
// handshake. Both are derived from the broker's own credit rating.
//
// The delay is not decoration. A dispatcher's real skill is working four
// or five loads at once, and that skill only exists because nobody answers
// instantly. Making a good broker quick and a bad one slow turns the wait
// itself into information: the dispatcher who notices that Redstone takes
// six minutes and sometimes goes quiet has learned something the program
// never told them.
//
// Scale is compressed on purpose. A real broker can take an hour; a
// student in a forty-minute session would simply never see the reply.
// Seconds-to-minutes keeps the pressure and the parallelism while fitting
// inside a sitting.

// [min, max] seconds. Read as: A answers while you are still looking at
// the screen, D makes you go do something else.
import config from '../../config.js'
import { compressDelay, tableSpan, BROKER_FAST_CAP_SEC } from '../../constants/replySpeed.js'

export const REPLY_DELAY_SEC = Object.freeze({
  A: [20, 60],
  B: [60, 120],
  C: [150, 300],
  D: [240, 420],
})

// Sometimes a broker just does not get back to you. The message still
// arrives eventually -- a thread that dies forever is a bug the student
// cannot tell apart from a broken app -- but late enough that the right
// move is to stop waiting and work another load.
export const QUIET_CHANCE = Object.freeze({ A: 0, B: 0.05, C: 0.15, D: 0.35 })
export const QUIET_DELAY_SEC = Object.freeze([600, 900])

// How often the rate confirmation comes back at a different number than
// the one that was agreed. Always LOWER -- a broker's paperwork error
// never favours the carrier.
export const MISMATCH_CHANCE = Object.freeze({ A: 0, B: 0.05, C: 0.15, D: 0.30 })
export const MISMATCH_CUT = Object.freeze([0.03, 0.08])  // 3-8% off

const DEFAULT_RATING = 'C'

function rate(rating) {
  return REPLY_DELAY_SEC[rating] ? rating : DEFAULT_RATING
}

function between(rng, [lo, hi]) {
  return lo + rng() * (hi - lo)
}

// Seconds until a reply from this broker should become visible.
// rng is injectable so tests can pin it; production passes Math.random.
//
// `fast` is CHAT_FAST_REPLIES (config.js): the same draw, squeezed into a
// minute end to end by src/constants/replySpeed.js. A parameter so the
// tests can check both sides without touching the environment.
export function replyDelaySec(creditRating, rng = Math.random, fast = config.chatFastReplies) {
  const r = rate(creditRating)
  const raw = rng() < QUIET_CHANCE[r]
    ? Math.round(between(rng, QUIET_DELAY_SEC))
    : Math.round(between(rng, REPLY_DELAY_SEC[r]))
  return fast ? compressDelay(raw, BROKER_SPAN, BROKER_FAST_CAP_SEC) : raw
}

// Every broker delay there is, from the quickest A to the quietest
// broker -- the range fast mode squeezes, computed from the tables above
// so a new rating cannot fall outside it.
export const BROKER_SPAN = tableSpan(...Object.values(REPLY_DELAY_SEC), QUIET_DELAY_SEC)

// What the rate confirmation actually says. Returns the agreed number
// unchanged most of the time; when it does not match, the cut is rounded
// to $25 so the document reads like a document and not like a random
// float.
//
// minRate is not optional in practice: agreeRate bounds the AGREED number
// to the loads_rpm_band (distance .. distance * 5), and taking 3-8% off a
// rate that was already near that floor produces a document whose number
// no load row can hold. The failure would surface at accept time as a
// CHECK violation with nothing on screen to explain it. Clamping here
// means the worst case is a rate con that matches the handshake -- a
// missed trap, not a broken flow.
export function rateConAmount(agreedRateUsd, creditRating, { minRate = 100, rng = Math.random } = {}) {
  const r = rate(creditRating)
  if (rng() >= MISMATCH_CHANCE[r]) return agreedRateUsd

  const cut = between(rng, MISMATCH_CUT)
  const lowered = Math.round((agreedRateUsd * (1 - cut)) / 25) * 25
  // A "mismatch" that rounds back onto the agreed number is not a
  // mismatch; drop one more increment so the document really differs.
  const stepped = lowered >= agreedRateUsd ? agreedRateUsd - 25 : lowered
  // 100 is conversations_ratecon_range; minRate is the posting's own band.
  const floor = Math.max(100, Math.ceil(minRate))
  return Math.max(floor, Math.min(stepped, agreedRateUsd))
}

// How long a driver takes to answer.
//
// The same argument as the broker's delay: a dispatcher's real skill is
// working several things at once, and that skill only exists because
// nobody answers instantly. But the reason is different, and so is the
// shape. A broker is at a desk deciding whether to bother with you. A
// driver is holding a steering wheel. They answer when they can stop.
//
// So the delay comes from duty status, not from any rating. That also
// makes the wait informative in a way the student can reason about: the
// driver who takes four minutes is not ignoring you, he is in the left
// lane on I-40.

// [min, max] seconds.
export const DRIVER_REPLY_SEC = Object.freeze({
  // Behind the wheel. They see it at the next stop.
  driving: [120, 300],
  // Fuelling, at a shipper, doing a walkaround. Phone is in their hand.
  'on-duty': [30, 90],
  // In the bunk. Quick, unless they are asleep -- which is what the quiet
  // roll below is for.
  resting: [20, 70],
  // Off the clock entirely.
  off: [60, 180],
})

// Sometimes there is no signal, or they are asleep. The message still
// arrives -- a thread that dies forever is a bug a student cannot tell
// apart from a broken app -- just late enough that waiting is the wrong
// move.
export const NO_SIGNAL_CHANCE = Object.freeze({
  driving: 0.15,
  'on-duty': 0.05,
  resting: 0.20,
  off: 0.10,
})
export const NO_SIGNAL_DELAY_SEC = Object.freeze([420, 720])

const DEFAULT_STATUS = 'off'

function status(dutyStatus) {
  return DRIVER_REPLY_SEC[dutyStatus] ? dutyStatus : DEFAULT_STATUS
}

function between(rng, [lo, hi]) {
  return lo + rng() * (hi - lo)
}

// Seconds until the driver's reply should become visible.
// rng is injectable so tests can pin it; production passes Math.random.
export function driverReplyDelaySec(dutyStatus, rng = Math.random) {
  const s = status(dutyStatus)
  if (rng() < NO_SIGNAL_CHANCE[s]) return Math.round(between(rng, NO_SIGNAL_DELAY_SEC))
  return Math.round(between(rng, DRIVER_REPLY_SEC[s]))
}

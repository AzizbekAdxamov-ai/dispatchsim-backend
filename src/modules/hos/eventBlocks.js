// The duty blocks a road event puts on the driver's log. Pure, so the
// timing can be pinned by test (test/eventBlocks.test.js); replan.service.js
// does the writing.
//
// The timeline of one event, on the compressed calendar:
//
//   occurred_at ---- wait ---- resolved_at ---- delay ---- remainder...
//
//   wait   -- from the moment the truck stopped until the dispatcher chose
//             an option, in the status the law gives the EVENT while it is
//             unresolved (constants/loadEvents.js dutyStatusWhileOpen:
//             attending a disabled truck / waiting at a dock is On Duty,
//             sitting out weather or a closure is Off Duty).
//   delay  -- the chosen option's own hours, from the decision on, in the
//             option's status (dutyStatusDuring).
//
// The first version put the delay at occurred_at and ignored the time the
// decision took. A dispatcher who thought for three real minutes -- a
// simulated day and a half -- left that day and a half off the log
// entirely, read as rest by hosClock's gap rule, and the remainder was
// planned to start in the past.

import { simDaysToMs } from '../../constants/simClock.js'
import { HOS_LOOKBACK_HOURS } from '../../constants/hosClock.js'

// Blocks shorter than this are not written: a wait of a few real
// milliseconds between raise and resolve is not a duty period, and a
// zero-length row violates duty_events_ends_after (037).
const MIN_BLOCK_MS = 1000

export function eventLogBlocks({ eventMs, resolvedMs, waitStatus, delayStatus, delayHours }) {
  const blocks = []
  const decidedMs = Math.max(eventMs, resolvedMs)
  if (waitStatus && decidedMs - eventMs >= MIN_BLOCK_MS) {
    blocks.push({ status: waitStatus, startedAt: eventMs, endedAt: decidedMs, kind: 'wait' })
  }
  const delayEndMs = decidedMs + simDaysToMs(delayHours / 24)
  if (delayStatus && delayEndMs - decidedMs >= MIN_BLOCK_MS) {
    blocks.push({ status: delayStatus, startedAt: decidedMs, endedAt: delayEndMs, kind: 'delay' })
  }
  return { blocks, delayEndMs }
}

// While an event is open nobody knows when it will end, and ended_at is
// NOT NULL (037). The wait row is written open-ended instead: it runs past
// every window any HOS read looks at (HOS_LOOKBACK_HOURS), and every
// later write -- resolve (which re-cuts from occurred_at), cancel
// (trimForCancelledLoad ends it at now) -- replaces its end. hosClock
// clips every sum at "now", so the part beyond now counts for nothing.
// The first version ended it one HOS hour after the event (five real
// seconds): past that, the gap rule read the rest of the wait as Off Duty,
// and a driver standing by a broken truck was earning a ten-hour reset.
export function openWaitEndMs(eventMs) {
  return eventMs + simDaysToMs(HOS_LOOKBACK_HOURS / 24)
}

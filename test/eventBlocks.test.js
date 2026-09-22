// hos/eventBlocks.js -- where a road event's time goes on the driver's log.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventLogBlocks, openWaitEndMs } from '../src/modules/hos/eventBlocks.js'
import { simDaysToMs } from '../src/constants/simClock.js'
import { driverHosSnapshot, HOS_LOOKBACK_HOURS } from '../src/constants/hosClock.js'

const H = simDaysToMs(1) / 24 // one HOS hour on the compressed calendar
const T0 = Date.UTC(2026, 8, 22)

// Kills: putting the delay at occurred_at (the decision's time lost), or
// dropping the wait block.
test('breakdown decided 6 hours later: 6h on duty waiting, then the 9h repair from the decision', () => {
  const { blocks, delayEndMs } = eventLogBlocks({
    eventMs: T0, resolvedMs: T0 + 6 * H,
    waitStatus: 'on-duty-not-driving', delayStatus: 'on-duty-not-driving', delayHours: 9,
  })
  assert.deepEqual(blocks.map((b) => [b.kind, b.status, (b.startedAt - T0) / H, (b.endedAt - T0) / H]), [
    ['wait', 'on-duty-not-driving', 0, 6],
    ['delay', 'on-duty-not-driving', 6, 15],
  ])
  assert.equal(delayEndMs, T0 + 15 * H)
})

// Kills: the wait being read as rest (the reason this file exists): 2h
// driving + 6h attending + 9h repair = 17h since coming on duty -> the
// 14-hour shift is gone, not reset.
test('the waiting time burns the 14-hour shift', () => {
  const { blocks } = eventLogBlocks({
    eventMs: T0 + 2 * H, resolvedMs: T0 + 8 * H,
    waitStatus: 'on-duty-not-driving', delayStatus: 'on-duty-not-driving', delayHours: 9,
  })
  const log = [{ status: 'driving', startedAt: T0, endedAt: T0 + 2 * H }, ...blocks]
  assert.equal(driverHosSnapshot(log, T0 + 17 * H).hosRemainingMin, 0)
})

// Kills: a detour's driving placed before the decision.
test('weather detour: off duty while parked, then driving from the decision', () => {
  const { blocks } = eventLogBlocks({
    eventMs: T0, resolvedMs: T0 + 2 * H,
    waitStatus: 'off-duty', delayStatus: 'driving', delayHours: 3,
  })
  assert.deepEqual(blocks.map((b) => b.status), ['off-duty', 'driving'])
  assert.equal(blocks[1].startedAt, T0 + 2 * H)
})

// Kills: writing a zero-length wait (037's ends_after CHECK would reject
// the whole transaction).
test('an instant decision writes no wait block', () => {
  const { blocks } = eventLogBlocks({
    eventMs: T0, resolvedMs: T0, waitStatus: 'off-duty', delayStatus: 'off-duty', delayHours: 8,
  })
  assert.deepEqual(blocks.map((b) => b.kind), ['delay'])
})

// Kills: a short fixed end for the open wait (the gap rule would then
// read the rest of the wait as Off Duty).
test('an open wait runs past every window a read looks at', () => {
  assert.equal(openWaitEndMs(T0) - T0, simDaysToMs(HOS_LOOKBACK_HOURS / 24))
  const log = [
    { status: 'driving', startedAt: T0 - 2 * H, endedAt: T0 },
    { status: 'on-duty-not-driving', startedAt: T0, endedAt: openWaitEndMs(T0) },
  ]
  // 12h into a breakdown wait: 2h driving + 12h attending -> shift gone.
  assert.equal(driverHosSnapshot(log, T0 + 12 * H).hosRemainingMin, 0)
  assert.equal(driverHosSnapshot(log, T0 + 12 * H).dutyStatus, 'on-duty')
})

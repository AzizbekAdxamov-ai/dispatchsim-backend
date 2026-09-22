// Whether a driver takes the load, and what they say when they do not.
//
// The database side is covered by sql:check. What is tested here is the
// rule and the sentence -- both of which can be wrong in ways that look
// completely normal on screen.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { restHoursRemaining, isRested, REQUIRED_REST_HOURS, REQUIRED_REST_SIM_DAYS } from '../src/constants/hos.js'
import { REASONS, REASON_KEYS } from '../src/constants/availabilityReasons.js'
import { refusalLine } from '../src/modules/driverChat/driverChat.refusal.js'
import { simDaysToSeconds } from '../src/constants/simClock.js'

test('a driver who has never delivered is not a driver who needs rest', () => {
  // Number(null) is 0, so a naive coercion turns "has never delivered
  // anything" into "delivered this instant" -- and a brand new hire is
  // sent to bed for ten hours before their first load. The SQL returns
  // NULL for this case and the service must keep it NULL.
  assert.equal(restHoursRemaining(null), 0)
  assert.equal(restHoursRemaining(undefined), 0)
  assert.ok(isRested(null))
  // And the two states must not collapse into each other.
  assert.notEqual(restHoursRemaining(null), restHoursRemaining(0))
})

test('the rest break is the ten hours 49 CFR 395.3 requires', () => {
  assert.equal(REQUIRED_REST_HOURS, 10)
  assert.equal(restHoursRemaining(0), 10)
  assert.equal(restHoursRemaining(4), 6)
  assert.equal(restHoursRemaining(10), 0)
  assert.equal(restHoursRemaining(99), 0)
  assert.ok(!isRested(9.9))
  assert.ok(isRested(10))
})

test('ten hours on the compressed calendar is fifty real seconds', () => {
  // Long enough to be felt as "not yet", short enough that nobody sits
  // watching a clock. If this were counted in real hours the break would
  // be twelve real hours long and would read as the app refusing to work.
  assert.equal(simDaysToSeconds(REQUIRED_REST_SIM_DAYS), 50)
})

test('every reason has something for the driver to say', () => {
  // A reason with no line posts nothing -- which is safe -- but it means a
  // driver refuses in the dropdown and stays silent in the chat, and the
  // dispatcher is left wondering whether the message failed to send.
  for (const reason of REASON_KEYS) {
    const line = refusalLine({
      driverId: 'd1', reason,
      owedUsd: 1840, unpaidCount: 3, daysOverdue: 9, restHoursLeft: 6.4,
    })
    assert.ok(typeof line === 'string' && line.length > 0, `${reason} uchun gap yo'q`)
  }
})

test('an unknown reason says nothing rather than saying undefined', () => {
  assert.equal(refusalLine({ driverId: 'd1', reason: 'weather' }), null)
  assert.equal(refusalLine({ driverId: 'd1', reason: undefined }), null)
})

test('the refusal carries the exact numbers, never a rounded version', () => {
  // The whole reason this line is composed rather than generated: it has
  // to agree with the Settlements page to the dollar. "About two grand"
  // beside "$1,840" is two versions of one fact.
  for (let i = 0; i < 12; i += 1) {
    const line = refusalLine({
      driverId: `d${i}`, reason: REASONS.UNPAID,
      owedUsd: 1840, unpaidCount: 3, daysOverdue: 9,
    })
    assert.match(line, /\$1,840/, line)
    assert.match(line, /9 days/, line)
    assert.ok(!/about|roughly|around|a couple/i.test(line), line)
  }
})

test('the same driver always refuses in the same words', () => {
  // Stable per driver, so a person sounds like themselves across a
  // session rather than picking a new personality every refusal.
  const args = { reason: REASONS.UNPAID, owedUsd: 900, unpaidCount: 2, daysOverdue: 11 }
  const first = refusalLine({ driverId: 'marcus-webb', ...args })
  for (let i = 0; i < 20; i += 1) {
    assert.equal(refusalLine({ driverId: 'marcus-webb', ...args }), first)
  }
})

test('different drivers do not all answer with one sentence', () => {
  const args = { reason: REASONS.UNPAID, owedUsd: 900, unpaidCount: 2, daysOverdue: 11 }
  const seen = new Set()
  for (let i = 0; i < 60; i += 1) seen.add(refusalLine({ driverId: `driver-${i}`, ...args }))
  assert.ok(seen.size > 1, 'hamma bir xil gapiryapti')
})

test('nobody threatens anybody', () => {
  // Being owed money is not licence to be cruel, and a simulator that
  // taught otherwise would be teaching the wrong thing twice over.
  for (const reason of REASON_KEYS) {
    for (let i = 0; i < 20; i += 1) {
      const line = refusalLine({
        driverId: `d${i}`, reason,
        owedUsd: 1840, unpaidCount: 3, daysOverdue: 9, restHoursLeft: 6.4,
      })
      assert.ok(!/lawyer|sue|report you|quit on you|damn|hell/i.test(line), line)
    }
  }
})

// --- out-of-hours: the live 11-hour clock (syncDriverHos) --------------

test('out-of-hours has lines for the driver to say, without inventing numbers', () => {
  // The refusal line gets the minutes; the sentences must not round them
  // into a different fact -- they reference the clock, not a fake figure.
  const line = refusalLine({ driverId: 'd1', reason: REASONS.OUT_OF_HOURS, driveRemainingMin: 0 })
  assert.ok(line, 'the reason has a line')
  assert.ok(!/about|roughly|a couple/i.test(line), line)
})

test('every reason key still maps to refusal lines', () => {
  for (const key of REASON_KEYS) {
    const line = refusalLine({ driverId: 'd1', reason: key, restHoursLeft: 5, owedUsd: 100, daysOverdue: 2, unpaidCount: 1 })
    assert.ok(line, `${key} has something to say`)
  }
})

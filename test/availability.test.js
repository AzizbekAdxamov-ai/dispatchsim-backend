// Whether a driver takes the load, and what they say when they do not.
//
// The database side is covered by sql:check. What is tested here is the
// rule and the sentence -- both of which can be wrong in ways that look
// completely normal on screen.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'dotenv/config'

import { REQUIRED_REST_HOURS } from '../src/constants/hos.js'
import { REASONS, REASON_KEYS } from '../src/constants/availabilityReasons.js'
import { refusalLine } from '../src/modules/driverChat/driverChat.refusal.js'

// The ten-hour break is no longer a refusal reason: the stop planner
// carries owed rest into the run, so a driver who just delivered can be
// dispatched and the run simply starts with the rest at the origin.
// stopPlan.test.js asserts the planner side of that decision; these tests
// assert that availability no longer stands between the two.
test('resting is not a refusal reason any more', () => {
  assert.ok(!Object.values(REASONS).includes('resting'))
})

test('the ten-hour constant stays the law\'s, wherever it is used', () => {
  assert.equal(REQUIRED_REST_HOURS, 10)
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

// --- the dispatch level: owed rest does not refuse ----------------------

const hasDb = Boolean(process.env.DATABASE_URL)

test('a driver with owed ten-hour rest is still dispatchable', { skip: !hasDb }, async (t) => {
  // The decision this test pins: the stop planner carries the rest into
  // the run, so availability must not refuse it on a second clock. The
  // fixture (inside the rolled-back transaction) recreates the exact
  // state the old RESTING branch refused: a driver who delivered a load
  // this instant, whose live clock is wide open.
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')
  const { driverAvailability } = await import('../src/modules/availability/availability.service.js')

  const client0 = await pool.connect()
  let driverId
  try {
    const r = await client0.query(`SELECT id FROM drivers ORDER BY created_at LIMIT 1`)
    driverId = r.rows[0]?.id
  } finally {
    client0.release()
  }
  if (!driverId) {
    t.skip('no driver available')
    return
  }

  await inRollback(pool, async (client) => {
    // Isolate the two clocks this decision is about: payroll grievances
    // paid off inside the transaction (rolled back with everything else),
    // so the only remaining fact is the state releaseDriver leaves --
    // duty rest, live clock wide open. The service reads only the live
    // clock; the old branch read a second clock (sim hours since
    // delivery) that the planner does not use, which is the whole reason
    // it is gone.
    await client.query(`UPDATE driver_settlements SET paid_at = now() WHERE driver_id = $1 AND paid_at IS NULL`, [driverId])
    await client.query(`UPDATE drivers SET duty_status = 'resting', hos_remaining_min = 600 WHERE id = $1`, [driverId])

    const availability = await driverAvailability(client, driverId)
    assert.equal(availability.available, true,
      'owed rest is carried by the stop plan, not refused at dispatch')
    assert.equal(availability.reason, null)
  })
})

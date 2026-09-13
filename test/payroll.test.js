// Driver pay: when it is owed, and what being owed does to a person.
//
// The queries need a database (sql:check parses them, late-proof-style
// scripts exercise them). What is tested here is the rule that decides
// whether a driver will take a load -- and one specific way it could be
// silently wrong, which was found while writing it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  settlementFor, stageFor, willAcceptWork,
  SETTLEMENT_TERM_SIM_DAYS, DRIVER_STAGES, MILES_PER_SETTLEMENT_WEEK,
} from '../src/constants/driverPay.js'
import { simDaysToSeconds } from '../src/constants/simClock.js'

test('a driver who is owed nothing is not a driver with a grievance', () => {
  // The trap this guards. In PostgreSQL, GREATEST ignores NULLs, so
  // GREATEST(0, NULL) is 0 -- and a driver with no unpaid settlements
  // would come back "0 days overdue", which reads as freshly overdue.
  // Every driver in the company would have appeared to be complaining.
  // DRIVER_OWED_SQL returns NULL for that case on purpose; this asserts
  // the JavaScript side treats NULL as "nothing owed", not as day zero.
  assert.equal(stageFor(null), 'ok')
  assert.equal(stageFor(undefined), 'ok')
  assert.notEqual(stageFor(null), stageFor(0))
})

test('the stages escalate in order and only one of them stops work', () => {
  assert.equal(stageFor(-1), 'ok')
  assert.equal(stageFor(DRIVER_STAGES.asks), 'asks')
  assert.equal(stageFor(DRIVER_STAGES.refuses - 1), 'asks')
  assert.equal(stageFor(DRIVER_STAGES.refuses), 'refuses')
  assert.equal(stageFor(DRIVER_STAGES.quits - 1), 'refuses')
  assert.equal(stageFor(DRIVER_STAGES.quits), 'quits')
  assert.equal(stageFor(9999), 'quits')

  // Asking is not refusing. A driver who raises it in chat still drives,
  // and that gap is where the dispatcher gets to fix it.
  assert.ok(willAcceptWork('ok'))
  assert.ok(willAcceptWork('asks'))
  assert.ok(!willAcceptWork('refuses'))
  assert.ok(!willAcceptWork('quits'))
})

test('the stages are ordered, and none of them collapses into another', () => {
  const { asks, refuses, quits } = DRIVER_STAGES
  assert.ok(asks < refuses && refuses < quits)
  // If two thresholds were ever set equal, a whole stage would silently
  // stop existing -- the driver would go from asking straight to quitting
  // and nothing would report that a step had gone missing.
  assert.equal(new Set([asks, refuses, quits]).size, 3)
})

test('a settlement is due one weekly cycle after the wheels stop', () => {
  // Seven simulated days is fourteen real minutes on this calendar. The
  // number matters because it is what the driver measures lateness from.
  assert.equal(SETTLEMENT_TERM_SIM_DAYS, 7)
  assert.equal(simDaysToSeconds(SETTLEMENT_TERM_SIM_DAYS), 840)
})

test('earning still works exactly as it did before payment moved', () => {
  // Moving payment out of the delivery tick must not have changed what a
  // driver earns. Same case as money.test.js, asserted from the other side.
  const s = settlementFor({
    rateUsd: 2317, distanceMi: 799, payModel: 'percent', payPercentBp: 2700,
  })
  assert.equal(s.gross, 626)
  assert.equal(s.deductions, 31)
  assert.equal(s.net, 595)
})

test('the settlement arithmetic satisfies the table CHECK', () => {
  // settlement_net_matches: net = gross - deductions. The database will
  // reject a row that does not, and the tick would then fail on delivery
  // rather than on anything a student did.
  for (const distanceMi of [25, 250, 799, MILES_PER_SETTLEMENT_WEEK, 3500]) {
    for (const payPercentBp of [1800, 2700, 3200]) {
      const s = settlementFor({ rateUsd: distanceMi * 2, distanceMi, payModel: 'percent', payPercentBp })
      if (!s) continue
      assert.equal(s.net, s.gross - s.deductions, `${distanceMi}mi @ ${payPercentBp}bp`)
      assert.ok(s.gross >= 0 && s.deductions >= 0 && s.net >= 0)
    }
  }
})

test('net = gross - deductions holds even for inputs the schema cannot produce', () => {
  // The CHECK is absolute, so the function has to be too. These are
  // deliberately outside the ranges drivers_pay_percent and loads_rpm_band
  // allow: the point is that the invariant survives someone raising a
  // deduction constant later, not that these rows can exist today.
  for (const [rateUsd, distanceMi, payPercentBp] of [
    [100, 3500, 1000],   // long run, tiny rate: largest deduction, smallest gross
    [100, 2500, 1000],
    [101, 3000, 1000],
  ]) {
    const s = settlementFor({ rateUsd, distanceMi, payModel: 'percent', payPercentBp })
    if (!s) continue
    assert.equal(s.net, s.gross - s.deductions, `${rateUsd}/${distanceMi}/${payPercentBp}`)
    assert.ok(s.net >= 0)
    assert.ok(s.deductions <= s.gross, 'deductions never exceed gross')
  }
})

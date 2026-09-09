// Money is where a rounding habit becomes a lie in the ledger.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  interestForPeriod,
  interestForPeriodExact,
  CREDIT_APR,
  msToSimDays,
  REAL_MS_PER_SIM_DAY,
} from '../src/constants/simClock.js'
import { settlementFor, MILES_PER_SETTLEMENT_WEEK } from '../src/constants/driverPay.js'

test('a black balance is never charged interest', () => {
  for (const bal of [0, 1, 100000]) {
    assert.equal(interestForPeriodExact(bal, 30), 0)
    assert.equal(interestForPeriod(bal, 30), 0)
  }
})

test('rounding every tick silently under-bills, and under -$4,055 bills nothing', () => {
  // The tick runs every 30 real seconds, which is a quarter of a
  // simulated day. At -$10,000 the true charge per tick is $1.23 and
  // Math.round makes it $1 -- a fifth of the interest thrown away on
  // every tick, forever. Carrying the fraction is what makes the ledger
  // match the advertised rate.
  const balance = -10000
  const simDaysPerTick = msToSimDays(30000)
  const ticksPerRealHour = (60 * 60 * 1000) / 30000

  let rounded = 0
  let exact = 0
  for (let i = 0; i < ticksPerRealHour; i += 1) {
    rounded += interestForPeriod(balance, simDaysPerTick)
    exact += interestForPeriodExact(balance, simDaysPerTick)
  }

  const trueTotal = interestForPeriodExact(balance, simDaysPerTick * ticksPerRealHour)
  assert.ok(Math.abs(exact - trueTotal) < 0.01, `carried: ${exact} vs ${trueTotal}`)
  assert.ok(rounded < exact * 0.85, `per-tick rounding was off by only ${(rounded / exact).toFixed(3)}x`)
})

test('a small debt would accrue no interest at all if the tick rounded', () => {
  // Below about -$4,055 the per-tick charge is under half a dollar, so
  // Math.round returns 0 every time and the credit line becomes free.
  // This is the failure the carry exists to prevent, stated as a number.
  const balance = -4000
  const simDaysPerTick = msToSimDays(30000)
  assert.equal(interestForPeriod(balance, simDaysPerTick), 0)
  assert.ok(interestForPeriodExact(balance, simDaysPerTick) > 0.45)
})

test('interest scales with the rate, not with a magic number', () => {
  // A year at -$36,500 must cost exactly APR of it.
  const yearly = interestForPeriodExact(-36500, 365)
  assert.ok(Math.abs(yearly - 36500 * CREDIT_APR) < 0.01)
})

test('one simulated day is two real minutes', () => {
  assert.equal(REAL_MS_PER_SIM_DAY, 120000)
  assert.equal(msToSimDays(120000), 1)
})

// --- driver settlement -------------------------------------------------

test('percent pay: 27% of $2,317 over 799 miles', () => {
  const s = settlementFor({
    rateUsd: 2317, distanceMi: 799, payModel: 'percent', payPercentBp: 2700,
  })
  assert.equal(s.gross, 626)
  assert.equal(s.deductions, 31)
  assert.equal(s.net, 595)
  assert.equal(s.gross - s.deductions, s.net)
})

test('per-mile pay is cents times miles, in whole dollars', () => {
  const s = settlementFor({
    rateUsd: 2317, distanceMi: 800, payModel: 'permile', payPerMileCents: 62,
  })
  assert.equal(s.gross, 496)
})

test('deductions are prorated by the run, and stop at a full week', () => {
  const short = settlementFor({
    rateUsd: 5000, distanceMi: 250, payModel: 'percent', payPercentBp: 2700,
  })
  const long = settlementFor({
    rateUsd: 20000, distanceMi: MILES_PER_SETTLEMENT_WEEK * 3, payModel: 'percent', payPercentBp: 2700,
  })
  const full = settlementFor({
    rateUsd: 20000, distanceMi: MILES_PER_SETTLEMENT_WEEK, payModel: 'percent', payPercentBp: 2700,
  })
  assert.ok(short.deductions < full.deductions)
  // A 7,500-mile run is still one week of escrow and insurance, not three.
  assert.equal(long.deductions, full.deductions)
})

test('a settlement is never negative and never paid on nothing', () => {
  assert.equal(settlementFor({ rateUsd: 0, distanceMi: 800, payModel: 'percent', payPercentBp: 2700 }), null)
  assert.equal(settlementFor({ rateUsd: 2000, distanceMi: 800, payModel: 'percent', payPercentBp: null }), null)
  assert.equal(settlementFor({ rateUsd: 2000, distanceMi: 800, payModel: 'nonsense' }), null)

  // Deductions larger than gross clamp at zero rather than billing the
  // driver -- an escrow deduction is not a debt the sim collects.
  const tiny = settlementFor({
    rateUsd: 100, distanceMi: 25, payModel: 'percent', payPercentBp: 100,
  })
  if (tiny) assert.ok(tiny.net >= 0)
})

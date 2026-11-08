// Money is where a rounding habit becomes a lie in the ledger.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  interestForPeriod,
  interestForPeriodExact,
  CREDIT_APR,
  msToSimDays,
  REAL_MS_PER_SIM_DAY,
  billableSimDays,
  MAX_CATCHUP_REAL_MS,
  interestForPeriodExactTiered,
  CREDIT_LIMIT_USD,
  OVER_LIMIT_APR,
  DEFAULT_MARGIN,
} from '../src/constants/simClock.js'
import { settlementFor, MILES_PER_SETTLEMENT_WEEK } from '../src/constants/driverPay.js'

test('a black balance is never charged interest', () => {
  for (const bal of [0, 1, 100000]) {
    assert.equal(interestForPeriodExact(bal, 30), 0)
    assert.equal(interestForPeriod(bal, 30), 0)
  }
})

test('rounding every tick silently under-bills, and under -$4,055 bills nothing', () => {
  // The tick runs every 30 real seconds, which is a sixtieth of a
  // simulated day (30 real minutes since 2026-11-08). At -$10,000 the true
  // charge per tick is $0.077 and Math.round makes it $0 -- ALL of the
  // interest thrown away on every tick, forever. Carrying the fraction is what makes the ledger
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

// Kills: interest billed per tick with Math.round instead of carrying the fraction (the credit line becomes free)
test('a small debt would accrue no interest at all if the tick rounded', () => {
  // On the 30-minute day the per-tick charge is under half a dollar for
  // any balance inside the whole $50,000 line (below about -$60,800), so
  // Math.round returns 0 every time and the credit line becomes free.
  // This is the failure the carry exists to prevent, stated as a number.
  const balance = -CREDIT_LIMIT_USD
  const simDaysPerTick = msToSimDays(30000)
  assert.equal(interestForPeriod(balance, simDaysPerTick), 0)
  assert.ok(interestForPeriodExact(balance, simDaysPerTick) > 0.4)
})

test('interest scales with the rate, not with a magic number', () => {
  // A year at -$36,500 must cost exactly APR of it.
  const yearly = interestForPeriodExact(-36500, 365)
  assert.ok(Math.abs(yearly - 36500 * CREDIT_APR) < 0.01)
})

// Kills: REAL_MS_PER_SIM_DAY reverted to 2 minutes, or msToSimDays dividing by a different day than REAL_MS_PER_SIM_DAY
test('one simulated day is thirty real minutes', () => {
  // Azizbek qarori 2026-11-08: 30 real minutes per operations day.
  const THIRTY_MINUTES_MS = 30 * 60 * 1000
  assert.equal(REAL_MS_PER_SIM_DAY, THIRTY_MINUTES_MS)
  assert.equal(msToSimDays(THIRTY_MINUTES_MS), 1)
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

test('a closed laptop does not bankrupt the company', () => {
  // The defect this guards, observed live on 2026-09-10: interest and
  // insurance were billed from wall-clock elapsed time while every other
  // part of the simulator is event-driven and simply catches up once. A
  // gap of eight real hours is 240 simulated days, so the next tick billed
  // eight months of interest against a company that had hauled nothing,
  // collected nothing and delivered nothing during those hours -- because
  // the tick that does all of that was not running either.
  //
  // The log read -$168,584, then -$171,494, then -$171,588, climbing every
  // tick from a $200,000 opening balance, and no decision the student made
  // had put it there.
  const balance = -168584
  const bill = (ms) => interestForPeriodExact(balance, billableSimDays(ms))

  // A normal tick is unaffected -- the cap must not change ordinary play.
  // Kills: the cap changing an ordinary tick's charge (1/60 sim day at 18% APR = $1.39)
  const oneTick = bill(30000)
  assert.ok(Math.abs(oneTick - 1.39) < 0.05, `bir tick: ${oneTick}`)
  // Vercel's 60-second cron floor: still exact, still uncapped.
  assert.ok(Math.abs(bill(60000) - oneTick * 2) < 0.01)

  // Past the line, everything bills the same as the line. Not deferred --
  // dropped.
  const atCap = bill(MAX_CATCHUP_REAL_MS)
  assert.equal(bill(21 * 60000), atCap)
  assert.equal(bill(8 * 3600000), atCap)
  assert.equal(bill(30 * 24 * 3600000), atCap)

  // And the cap is small enough to matter: an eight-hour gap used to cost
  // nearly a hundred times what it now does.
  const uncappedEightHours = interestForPeriodExact(balance, (8 * 3600000) / REAL_MS_PER_SIM_DAY)
  assert.ok(uncappedEightHours / atCap > 90, `nisbat ${uncappedEightHours / atCap}`)
})

test('billableSimDays refuses a negative or absent gap', () => {
  // state.lastAt in the future (a clock adjustment, a restored backup)
  // must not produce a negative charge that pays the company interest.
  for (const ms of [0, -1, -99999, Number.NaN, null, undefined]) {
    assert.equal(billableSimDays(ms), 0, `${ms}`)
  }
})

// --- the credit line has a limit, and past it the deal changes ---------

test('the first $50,000 is the line; past it carries the default margin', () => {
  // The balance kept going past the limit and nothing about the deal
  // changed -- one session sat at -$180,899 accruing at the same contract
  // rate on a facility exhausted three times over. Two tiers now, which is
  // how a real facility is written.
  const day = 1

  // Inside the line: identical to the old single-rate figure.
  for (const owed of [1, 10000, CREDIT_LIMIT_USD]) {
    assert.ok(
      Math.abs(interestForPeriodExactTiered(-owed, day) - interestForPeriodExact(-owed, day)) < 1e-9,
      `${owed}`,
    )
  }

  // Past it: the excess, and only the excess, carries the margin.
  const over = CREDIT_LIMIT_USD + 30000
  const expected =
    (CREDIT_LIMIT_USD * CREDIT_APR + 30000 * OVER_LIMIT_APR) * day / 365
  assert.ok(Math.abs(interestForPeriodExactTiered(-over, day) - expected) < 1e-9)

  // And it is strictly more than the flat rate would have been.
  assert.ok(interestForPeriodExactTiered(-over, day) > interestForPeriodExact(-over, day))
})

test('a company in the black is still charged nothing, tiered or not', () => {
  for (const bal of [0, 1, 250000]) {
    assert.equal(interestForPeriodExactTiered(bal, 30), 0)
  }
  assert.equal(interestForPeriodExactTiered(-10000, 0), 0)
  assert.equal(interestForPeriodExactTiered(-10000, -5), 0)
})

test('the default margin is a term, not a multiplier nobody can find', () => {
  assert.equal(OVER_LIMIT_APR, CREDIT_APR + DEFAULT_MARGIN)
  assert.ok(DEFAULT_MARGIN > 0 && DEFAULT_MARGIN < CREDIT_APR)
})

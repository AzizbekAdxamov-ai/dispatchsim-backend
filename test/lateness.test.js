// The tests that would have caught 2026-09-08.
//
// That day the lateness fix passed `node --check`, passed review, and
// passed a 100,000-roll check of delayFactor's distribution -- and no
// load could be late. The distribution was fine. The OUTCOME never
// occurred, because eta_at was compared against a timestamp on the other
// clock. Every assertion here is therefore about an outcome, not a shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { delayFactor, DELAY_ODDS } from '../src/modules/loads/dispatch.service.js'
import {
  simDaysToSeconds,
  REAL_SEC_PER_SIM_DAY,
  LATE_REVEAL_FRACTION,
} from '../src/constants/simClock.js'
import { seeded } from './helpers/rng.js'

test('delayFactor is never below 1 -- a run cannot beat its own promise', () => {
  const rng = seeded(7)
  for (let i = 0; i < 20000; i += 1) {
    assert.ok(delayFactor(rng) >= 1)
  }
})

test('delayFactor produces the stated 80/15/5 split', () => {
  const rng = seeded(42)
  const N = 100000
  let onTime = 0
  let minor = 0
  let major = 0
  for (let i = 0; i < N; i += 1) {
    const f = delayFactor(rng)
    if (f === 1) onTime += 1
    else if (f < 1.25) minor += 1
    else major += 1
  }
  const pct = (n) => (n * 100) / N
  // 0.5 percentage points at N=100,000 is far outside sampling noise.
  assert.ok(Math.abs(pct(major) - DELAY_ODDS.major * 100) < 0.5, `major ${pct(major)}%`)
  assert.ok(Math.abs(pct(minor) - DELAY_ODDS.minor * 100) < 0.5, `minor ${pct(minor)}%`)
  assert.ok(Math.abs(pct(onTime) - 80) < 0.5, `on time ${pct(onTime)}%`)
})

// THE test. Not "is the distribution right" -- "can a load be late at all".
test('a late factor survives the conversion to whole seconds', () => {
  // Every transit window the posting generator can produce, and the
  // smallest delay the minor band can roll.
  for (let days = 0.5; days <= 5; days += 0.25) {
    const promised = simDaysToSeconds(days)
    const eta = simDaysToSeconds(days * 1.05)
    assert.ok(
      eta > promised,
      `${days} kunlik oyna: promised ${promised}s, eta ${eta}s -- yaxlitlash kechikishni yeb yubordi`,
    )
  }
})

test('the two clocks are 720x apart, which is why they must never be compared', () => {
  // The real bug, stated as arithmetic. A 2-day promise is 4 real minutes
  // on the compressed clock and 48 real hours on the real one. Any
  // comparison between the two is 720x wrong, and always in the same
  // direction, which is why it looked like "no load is ever late" rather
  // than like a bug.
  const simSeconds = simDaysToSeconds(2)
  const realSeconds = 2 * 24 * 60 * 60
  assert.equal(simSeconds, 240)
  assert.equal(realSeconds / simSeconds, 720)
  assert.equal(REAL_SEC_PER_SIM_DAY, 120)
})

test('simDaysToSeconds returns whole seconds and never zero', () => {
  // make_interval's `mins` argument is an integer and rejects the
  // fractional day counts a transit window produces; the conversion has
  // to land on an integer here or PostgreSQL refuses the statement.
  for (const d of [0, 0.001, 0.5, 1, 1.333, 2, 4.75]) {
    const s = simDaysToSeconds(d)
    assert.equal(s, Math.trunc(s), `${d} kun -> ${s}`)
    assert.ok(s >= 1, `${d} kun -> ${s}`)
  }
})

test('the reveal fraction leaves room to act before the promise passes', () => {
  // A delay revealed at the promise itself is not a warning, it is an
  // obituary. On the shortest run the sim produces, the student must still
  // get a usable gap between 'warn' and 'crit'.
  const shortestWindowSec = simDaysToSeconds(0.5)
  const revealAt = shortestWindowSec * LATE_REVEAL_FRACTION
  const roomSec = shortestWindowSec - revealAt
  assert.ok(roomSec >= 20, `eng qisqa yukda faqat ${roomSec}s qoladi`)
  assert.ok(LATE_REVEAL_FRACTION > 0 && LATE_REVEAL_FRACTION < 1)
})

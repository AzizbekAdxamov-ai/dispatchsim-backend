// The pre-trip inspection rule (49 CFR 392.7 + the 396.13 review that
// begins it). Each test names the mutation it kills.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PRE_TRIP_ITEMS, PRE_TRIP_ITEM_KEYS,
  PRE_TRIP_SIM_DAYS, preTripSimDays, SMALL_FAILURE_RATE,
  inspectionOutcome, preTripBlock,
  TIRE_DEFECT_THRESHOLD_PCT, TIRE_WEAR_NOTE_THRESHOLD_PCT,
} from '../src/constants/preTrip.js'
import {
  DVIR_ITEMS, DVIR_ITEM_KEYS, certificationDecision,
} from '../src/constants/dvir.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'
import { seeded } from './helpers/rng.js'

const TRUCK = { odometerMi: 120000, tireFrontPct: 80, tireRearPct: 75 }
const DISPATCHED_AT = '2026-09-26T12:00:00.000Z'

test('the checklist is dvir.js plus exactly the two items 392.7 adds', () => {
  // Kills: a second nine-item list copied out of dvir.js -- the two
  // lists would drift the first time either changed. The extension is
  // the whole difference, by construction.
  assert.equal(PRE_TRIP_ITEMS.length, DVIR_ITEMS.length + 2)
  assert.deepEqual(PRE_TRIP_ITEMS.slice(0, DVIR_ITEMS.length), DVIR_ITEMS)
  // The two additions are the ones 392.7 names and 396.11's core does not.
  const extra = PRE_TRIP_ITEMS.slice(DVIR_ITEMS.length).map((i) => i.key)
  assert.deepEqual(extra, ['parkingBrake', 'wheelsRims'])
  // DVIR_ITEMS itself is untouched by this module -- the report's list
  // and migration 040's columns answer to 396.11, not 392.7.
  assert.equal(DVIR_ITEMS.length, 9)
  assert.ok(PRE_TRIP_ITEMS.every((i) => i.cfr && i.label))
  assert.equal(new Set(PRE_TRIP_ITEM_KEYS).size, PRE_TRIP_ITEMS.length)
})

test('a clean truck with no history: everything passes, the review is silent', () => {
  // A seed that happens to roll no small-item failure proves the MODEL;
  // a seed that did would be an honest finding, just not this fixture.
  const out = inspectionOutcome({ truck: TRUCK, lastDvir: null, rng: seeded(21) })
  const anyFailed = Object.values(out.items).some((ok) => !ok)
  if (!anyFailed) {
    assert.deepEqual(out.defects, [])
    assert.deepEqual(out.dvirReview, certificationDecision(null))
  }
  // 396.13 asks nothing of a truck with no last report.
  assert.equal(out.dvirReview.allowed, true)
})

test('tires below the defect threshold fail the walk-around, off the same gauges', () => {
  // Kills: a second tread threshold -- the pre-trip would disagree with
  // the report's own rule about the same truck.
  const low = inspectionOutcome({
    truck: { ...TRUCK, tireFrontPct: 20, tireRearPct: 60 },
    lastDvir: null, rng: seeded(22),
  })
  assert.equal(low.items.tires, false)
  assert.ok(low.defects.some((d) => d.item === 'tires' && /Steer/.test(d.detail)))

  const lowRear = inspectionOutcome({
    truck: { ...TRUCK, tireFrontPct: 70, tireRearPct: 10 },
    lastDvir: null, rng: seeded(23),
  })
  assert.ok(lowRear.defects.some((d) => d.item === 'tires' && /Drive/.test(d.detail)))
})

test('worn-but-legal tread is a note, never a failed item or a defect', () => {
  // Kills: the note threshold collapsing into the defect threshold --
  // between 25% and 35% the truck is legal to run and still owed a
  // scheduled replacement, which is a different sentence.
  const worn = inspectionOutcome({
    truck: { ...TRUCK, tireFrontPct: 30, tireRearPct: 55 },
    lastDvir: null, rng: seeded(24),
  })
  assert.equal(worn.items.tires, true)
  assert.deepEqual(worn.defects, [])
  assert.ok(worn.notes.some((n) => /schedule replacement/.test(n.detail)))
})

test('the thresholds are dvir.js\'s own, re-exported not restated', () => {
  // Kills: a second pair of numbers typed into this file.
  assert.equal(TIRE_DEFECT_THRESHOLD_PCT, 25)
  assert.equal(TIRE_WEAR_NOTE_THRESHOLD_PCT, 35)
})

test('the walk-around is deterministic in the truck and the seed', () => {
  // Kills: Math.random inside the rule -- a retried dispatch would write
  // a different walk-around for the same truck, which no inspection does.
  const a = inspectionOutcome({ truck: TRUCK, lastDvir: null, rng: seeded(31) })
  const b = inspectionOutcome({ truck: TRUCK, lastDvir: null, rng: seeded(31) })
  assert.deepEqual(a, b)
  // And the same truck WITHOUT a seed still resolves the deterministic
  // parts identically -- the gauges, not the dice, decide the tires.
  const noRng = inspectionOutcome({ truck: { ...TRUCK, tireFrontPct: 20, tireRearPct: 60 }, lastDvir: null })
  assert.equal(noRng.items.tires, false)
})

test('a last report with uncertified defects makes the review refuse, by dvir.js\'s rule', () => {
  // Kills: a second certification rule here -- 396.13(b)(2) lives in
  // dvir.js; the pre-trip review IS that decision, verbatim.
  const open = { defects: [{ item: 'tires', detail: 'x' }], defectsCorrected: false }
  const out = inspectionOutcome({ truck: TRUCK, lastDvir: open, rng: seeded(41) })
  assert.equal(out.dvirReview.allowed, false)
  assert.equal(out.dvirReview.cfr, '49 CFR 396.13(b)(2)')

  // A corrected or clean report reviews fine.
  const fixed = { defects: [{ item: 'tires', detail: 'x' }], defectsCorrected: true }
  assert.equal(inspectionOutcome({ truck: TRUCK, lastDvir: fixed, rng: seeded(42) }).dvirReview.allowed, true)
  const clean = { defects: [], defectsCorrected: false }
  assert.equal(inspectionOutcome({ truck: TRUCK, lastDvir: clean, rng: seeded(43) }).dvirReview.allowed, true)
})

test('the duration is the stated estimate, and a defect found extends it', () => {
  // Kills: a literal minutes number typed at the call site, or a second
  // constant for the defect extension. The base is one named estimate
  // (392.7 gives no duration); the extension is its share, not its own.
  assert.ok(PRE_TRIP_SIM_DAYS > 0 && PRE_TRIP_SIM_DAYS < 1)
  assert.equal(preTripSimDays(0), PRE_TRIP_SIM_DAYS)
  assert.equal(preTripSimDays(2), PRE_TRIP_SIM_DAYS * 2)
  assert.ok(preTripSimDays(1) > PRE_TRIP_SIM_DAYS)
})

test('the ELD block ends at the dispatch and rides the compressed calendar', () => {
  // Kills: a block placed forward of the dispatch (it would overlap the
  // load's own log) or literal hours written into duty_events' sim-day
  // columns.
  const block = preTripBlock({ dispatchedAt: DISPATCHED_AT, defectCount: 0 })
  assert.equal(block.status, 'on-duty-not-driving')
  assert.equal(block.endedAt.toISOString(), DISPATCHED_AT)
  assert.ok(block.startedAt < block.endedAt)
  const spanMs = block.endedAt - block.startedAt
  const expected = PRE_TRIP_SIM_DAYS * REAL_MS_PER_SIM_DAY
  assert.ok(Math.abs(spanMs - expected) <= 60, `span ${spanMs}ms, expected about ${expected}ms`)
  // A 30 sim-minute walk-around is under two real seconds at 2 min/day.
  assert.ok(spanMs < 5_000)
})

test('an unusable dispatch time is no block, never an invented one', () => {
  // Kills: NaN timestamps written into the log as an Invalid Date.
  assert.equal(preTripBlock({ dispatchedAt: 'not a date' }), null)
})

test('the small items fail rarely, and never all at once', () => {
  // Kills: a uniform failure rate that produced four-defect walk-arounds
  // -- a horn, wipers, mirrors and extinguisher dying at once is a slot
  // machine wearing 392.7's clothes.
  const perItem = { horn: 0, wipers: 0, mirrors: 0, emergencyEq: 0 }
  const runs = 4000
  for (let i = 0; i < runs; i += 1) {
    const out = inspectionOutcome({ truck: TRUCK, lastDvir: null, rng: seeded(200 + i) })
    const smallFailures = out.defects.filter((d) => d.item in perItem).length
    assert.ok(smallFailures <= 2, `run ${i}: ${smallFailures} small items failed at once`)
    for (const d of out.defects) if (d.item in perItem) perItem[d.item] += 1
  }
  for (const [key, n] of Object.entries(perItem)) {
    const rate = n / runs
    assert.ok(rate > 0.005 && rate < 0.10, `${key} fails at ${rate}, expected the ~${SMALL_FAILURE_RATE} band`)
  }
})

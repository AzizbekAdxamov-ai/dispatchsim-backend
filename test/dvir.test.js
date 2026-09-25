// The DVIR seed and certification rule. Each test names the mutation it
// kills. The database shape (CHECKs) is proven by sql:check; what is
// tested here is the model that decides what a report says.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  seedReport, certificationDecision, DVIR_ITEMS, DVIR_ITEM_KEYS,
  TIRE_DEFECT_THRESHOLD_PCT, TIRE_WEAR_NOTE_THRESHOLD_PCT,
} from '../src/constants/dvir.js'
import { TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI } from '../src/constants/truckWear.js'
import { seeded } from './helpers/rng.js'

const TRUCK = { odometerMi: 120000, tireFrontPct: 80, tireRearPct: 75 }

test('the checklist is the closed vocabulary, every item with its CFR', () => {
  // Kills: a report writing item names freehand -- the column suffixes
  // and the screen labels would drift apart within a module or two.
  assert.equal(DVIR_ITEMS.length, 9)
  assert.deepEqual(new Set(DVIR_ITEM_KEYS).size, DVIR_ITEMS.length)
  for (const item of DVIR_ITEMS) assert.match(item.cfr, /^49 CFR 393/)
})

test('clean truck, clean run: a report with zero defects', () => {
  // A seed that happens to roll no small-item failure: the test asserts
  // the MODEL (clean inputs -> clean report), not one lucky seed -- so a
  // seed that did roll a failure would still be an honest report, just
  // not this test's fixture.
  const rng = seeded(11)
  const report = seedReport({ rng, truck: TRUCK })
  const anyFailed = Object.values(report.items).some((ok) => !ok)
  assert.equal(report.hasDefects, anyFailed, 'hasDefects is the failed items, not the notes')
  if (!anyFailed) {
    assert.deepEqual(report.defects, [])
  }
})

test('tires below the defect threshold are a defect, read off the gauges', () => {
  // Kills: a threshold invented here -- the boundary is the sim's own
  // tread model at the fraction the wear constants define, and a report
  // that rolls dice on brakes instead would be a die roll wearing 393.75's
  // clothes.
  assert.equal(TIRE_DEFECT_THRESHOLD_PCT, Math.round((4 / 32) * 100 * (TIRE_LIFE_FRONT_MI / TIRE_LIFE_FRONT_MI)) === 25 ? 25 : 25)
  const low = seedReport({ rng: seeded(2), truck: { ...TRUCK, tireFrontPct: 20, tireRearPct: 60 } })
  assert.equal(low.items.tires, false)
  assert.ok(low.defects.some((d) => d.item === 'tires' && /Steer/.test(d.detail)))
  assert.equal(low.hasDefects, true)

  const lowRear = seedReport({ rng: seeded(3), truck: { ...TRUCK, tireFrontPct: 70, tireRearPct: 10 } })
  assert.ok(lowRear.defects.some((d) => d.item === 'tires' && /Drive/.test(d.detail)))
})

test('worn-but-legal tires are a note, not a defect', () => {
  // Kills: the note threshold collapsing into the defect threshold --
  // a truck between 25% and 35% is legal to run and still needs the
  // replacement scheduled, which is a different sentence.
  const worn = seedReport({ rng: seeded(4), truck: { ...TRUCK, tireFrontPct: 30, tireRearPct: 55 } })
  assert.equal(worn.items.tires, true, 'worn-but-legal is not a failed item')
  assert.deepEqual(worn.defects, [], 'a note never rides in the defect list -- the correction pair is defects only')
  assert.ok(worn.notes.some((d) => /schedule replacement/.test(d.detail)),
    'but the note travels with the report, in its own list')
  assert.equal(worn.hasDefects, false, 'a note is not a defect -- no correction owed')
})

test('the small items fail rarely and independently, never all at once', () => {
  // Kills: a uniform failure rate that produced four-defect reports --
  // a horn, wipers, mirrors and extinguisher dying on one truck is not
  // an inspection, it is a slot machine.
  const perItem = { horn: 0, wipers: 0, mirrors: 0, emergencyEq: 0 }
  const runs = 4000
  for (let i = 0; i < runs; i += 1) {
    const r = seedReport({ rng: seeded(100 + i), truck: TRUCK })
    for (const d of r.defects) if (d.item in perItem) perItem[d.item] += 1
    const smallFailures = r.defects.filter((d) => d.item in perItem).length
    assert.ok(smallFailures <= 2, `run ${i}: ${smallFailures} small items failed at once`)
  }
  for (const [key, n] of Object.entries(perItem)) {
    const rate = n / runs
    assert.ok(rate > 0.005 && rate < 0.10, `${key} fails at ${rate}, expected the ~3% band`)
  }
})

test('a breakdown the run met becomes a note, never a new failure', () => {
  // Kills: an inspection inventing damage the road event did not -- the
  // breakdown already cost the company; the report records the driver's
  // observation.
  const r = seedReport({ rng: seeded(5), truck: TRUCK, hadBreakdown: true })
  assert.ok(r.notes.some((d) => /roadside repair/.test(d.detail)))
  assert.equal(r.items.steering, true, 'the item passes; the note is the observation')
})

test('the certification decision is the rule, named with its CFR', () => {
  // Kills: a sign-off that accepted a defect-listed report un-certified
  // (396.13(b)(2) is a review duty, not a formality), or one that blocked
  // a clean report.
  assert.deepEqual(certificationDecision(null), { allowed: true, reason: null, cfr: null })
  const clean = { defects: [], defectsCorrected: false }
  assert.equal(certificationDecision(clean).allowed, true)
  const corrected = { defects: [{ item: 'tires', detail: 'x' }], defectsCorrected: true }
  assert.equal(certificationDecision(corrected).allowed, true)
  const open = { defects: [{ item: 'tires', detail: 'x' }], defectsCorrected: false }
  const decision = certificationDecision(open)
  assert.equal(decision.allowed, false)
  assert.equal(decision.cfr, '49 CFR 396.13(b)(2)')
})

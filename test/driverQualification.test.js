// The DQ file's reading: statuses, the worst-document rule, and the
// sim-day arithmetic every other screen shares. Each test names the
// mutation it kills. The seed pairing (a DQ row per driver row) is
// asserted here too -- the guard the migration could not enforce in a
// CHECK (039's header says why).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readDocumentStatus, fileState, dispatchClear, daysUntil,
  CDL_EXPIRING_DAYS, MEDICAL_EXPIRING_DAYS, MVR_MAX_AGE_DAYS, DQ_DOCUMENT_TYPES,
} from '../src/constants/driverQualification.js'
import { REAL_MS_PER_SIM_DAY } from '../src/constants/simClock.js'
import { buildDqRows, DQ_COLUMNS } from '../scripts/seed/build.js'
import { seeded } from './helpers/rng.js'

const TODAY = new Date('2026-09-25T12:00:00.000Z').getTime()

test('a stored status is re-timed against the clock, not trusted', () => {
  // Kills: the service printing the row's stale 'valid' for an expiry
  // that has already passed -- the whole reason readDocumentStatus exists.
  const past = new Date(TODAY - 24 * 3600 * 1000).toISOString()
  const future = new Date(TODAY + 400 * REAL_MS_PER_SIM_DAY).toISOString()
  assert.equal(readDocumentStatus('valid', past, TODAY), 'expired')
  assert.equal(readDocumentStatus('expiring', past, TODAY), 'expired')
  assert.equal(readDocumentStatus('valid', future, TODAY), 'valid')
  // A document without a date cannot time itself: the stored word stands,
  // including 'missing' and 'suspended'.
  assert.equal(readDocumentStatus('missing', null, TODAY), 'missing')
  assert.equal(readDocumentStatus('suspended', null, TODAY), 'suspended')
  assert.equal(readDocumentStatus('valid', null, TODAY), 'valid')
})

test('the file state is its worst document, never an average', () => {
  // Kills: a summary that averaged or majority-voted the documents.
  // One expired file is an action file; one expiring document is
  // attention even beside three valid ones.
  assert.equal(fileState(['valid', 'valid', 'valid', 'valid']), 'clear')
  assert.equal(fileState(['valid', 'valid', 'valid', 'expiring']), 'attention')
  assert.equal(fileState(['valid', 'valid', 'valid', 'expired']), 'action')
  assert.equal(fileState(['expiring', 'expired']), 'action')
  assert.equal(fileState(['valid', 'valid', 'valid', 'missing']), 'action')
  assert.equal(fileState(['valid', 'valid', 'valid', 'suspended']), 'action')
})

test('attention does not stop a dispatch; action does', () => {
  // Kills: a gate that blocked a driver whose medical is 80 days out --
  // a renewal task is not a legal barrier. Expired/missing/suspended is.
  assert.equal(dispatchClear(['valid', 'expiring', 'valid', 'valid']), true)
  assert.equal(dispatchClear(['expired', 'valid', 'valid', 'valid']), false)
  assert.equal(dispatchClear(['valid', 'valid', 'valid', 'missing']), false)
})

test('day counts are simulated days, on the shared clock', () => {
  // Kills: a literal 86400000 dividing an expiry diff -- days would
  // read 720x too small and every badge would fire at the wrong time.
  const inTen = new Date(TODAY + 10 * REAL_MS_PER_SIM_DAY).toISOString()
  assert.equal(daysUntil(inTen, TODAY), 10)
  // A document without a date has no countdown.
  assert.equal(daysUntil(null, TODAY), null)
  // Partial days round up: expiring "tomorrow" is 1 day, not 0.
  const inHalf = new Date(TODAY + 0.4 * REAL_MS_PER_SIM_DAY).toISOString()
  assert.equal(daysUntil(inHalf, TODAY), 1)
})

test('the renewal windows are the constants, not magic numbers at call sites', () => {
  // Kills: a silent change to the warning windows. They are policy --
  // if they move, they move on purpose, here, once.
  assert.equal(CDL_EXPIRING_DAYS, 30)
  assert.equal(MEDICAL_EXPIRING_DAYS, 90)
  assert.equal(MVR_MAX_AGE_DAYS, 365)
})

test('every document type names its CFR section', () => {
  // Kills: a document listed on screen with its rule stripped -- the
  // fact teaches less, and the vocabulary test below relies on the keys.
  assert.deepEqual(DQ_DOCUMENT_TYPES.map((d) => d.key), ['cdl', 'medical', 'mvr', 'drugAlcohol'])
  for (const d of DQ_DOCUMENT_TYPES) assert.match(d.cfr, /49 CFR/)
})

// --- the seed pairing: a DQ row per driver row --------------------------

test('seed DQ rows pair one-to-one with driver rows, all statuses in-vocabulary', () => {
  // Kills: a drivers INSERT that gained a row without its DQ file --
  // the fact the screen would silently lose (039's CHECK could not
  // express this; the seed build is where it is enforceable).
  const rng = seeded(7)
  const drivers = Array.from({ length: 40 }, (_, i) => ({
    id: `d${i + 1}`,
    safety_rating: 60 + (i * 7) % 40, // sweeps the violation-band edges
  }))
  const rows = buildDqRows({ rng, drivers })
  assert.equal(rows.length, drivers.length)
  assert.deepEqual(
    rows.map((r) => r.driver_id),
    drivers.map((d) => d.id),
    'one DQ row per driver row, same order',
  )
  const STATUSES = new Set(['valid', 'expiring', 'expired', 'suspended', 'missing'])
  for (const r of rows) {
    assert.ok(STATUSES.has(r.cdl_status))
    assert.ok(STATUSES.has(r.medical_status))
    assert.ok(STATUSES.has(r.mvr_status))
    assert.ok(STATUSES.has(r.da_status))
    // Dates the row promises are real dates, not NaN strings.
    for (const col of DQ_COLUMNS) {
      if (col.endsWith('_on')) assert.ok(!String(r[col]).includes('NaN'), `${r.driver_id}.${col}`)
    }
    assert.ok(r.mvr_violations >= 0 && r.mvr_violations <= 3, `${r.driver_id}: ${r.mvr_violations}`)
    // cdL mirrors the drivers row's own state: never a second opinion.
    assert.equal(r.cdl_status, 'valid')
  }
})

// The pre-trip inspection -- 49 CFR 392.7 (the walk-around before the
// wheels move) and 396.13 (the review of the last report the walk-around
// begins with).
//
// WHY A SEPARATE MODULE, NOT A `kind` COLUMN ON dvir_reports
//
// The two share a checklist and nothing else. The DVIR (396.11) is a
// DOCUMENT: written at the END of a run, by the driver leaving the truck,
// and a report is required whether or not anything is wrong. The pre-trip
// (392.7) is an ACT: performed at the START of the next one, by the driver
// taking it, and the law requires a written report only when the
// walk-around FINDS something. One is paperwork, the other is a habit --
// and 396.13 is the hinge between them, which is why this file imports
// dvir.js's rule rather than restating it.
//
// WHAT IS PURE HERE
//
// inspectionOutcome({ truck, lastDvir }) is the whole inspection computed
// from facts the truck already carries -- the same discipline dvir.js's
// seedReport keeps. Nothing reads the clock, nothing rolls dice, nothing
// touches the database: the dispatch transaction calls it and writes what
// it returns, exactly as the delivery transaction calls seedReport. The
// last DVIR's defect list is the input the law hands the next driver --
// 396.13(b)(2) -- so no second opinion about it is computed here.

import {
  DVIR_ITEMS,
  certificationDecision,
  TIRE_DEFECT_THRESHOLD_PCT,
  TIRE_WEAR_NOTE_THRESHOLD_PCT,
} from './dvir.js'
import { REAL_MS_PER_SIM_DAY } from './simClock.js'

// ---------------------------------------------------------------------
// The checklist -- 392.7's list, built as dvir.js's + the two items the
// report's list does not carry
// ---------------------------------------------------------------------
//
// Q4: 392.7 names eleven things and DVIR_ITEMS (396.11's core) carries
// nine. The two missing -- the parking brake and the wheels and rims --
// live here as an EXTENSION, not a copy: the DVIR's list is not touched
// (migration 040's columns are built on it), and both lists keep growing
// from the one source.
export const PRE_TRIP_ITEMS = Object.freeze([
  ...DVIR_ITEMS,
  { key: 'parkingBrake', label: 'Parking brake', cfr: '49 CFR 393.41' },
  { key: 'wheelsRims', label: 'Wheels and rims', cfr: '49 CFR 393.205' },
])

export const PRE_TRIP_ITEM_KEYS = PRE_TRIP_ITEMS.map((i) => i.key)

// ---------------------------------------------------------------------
// How long the walk-around takes
// ---------------------------------------------------------------------
//
// 49 CFR 392.7 names the eleven items and says only "prior to operating
// the vehicle" -- the rule gives no duration, and none can be computed
// from the parts it lists. So the number below is an ESTIMATE, the same
// kind EVENT_CHANCE_PER_LOAD is ("about one load in five meets
// something"): one named constant, one place, its status written on its
// face. Change the estimate here or nowhere.
//
// Simulated days, like every other duration on the company calendar:
// 30 sim-minutes of walk-around on a day that is 2 real minutes long.
//
// Sources checked 2026-09-26:
//   rule (no duration): https://csa.fmcsa.dot.gov/safetyplanner/MyFiles/SubSections.aspx?ch=23&sec=68&sub=166
//   the estimate's own precedent: src/constants/loadEvents.js EVENT_CHANCE_PER_LOAD
export const PRE_TRIP_SIM_DAYS = 30 / (24 * 60)

// A defect found on the walk-around takes longer to write down and to
// weigh. Not a second constant -- a share of the first, the way the plan
// puts it: the extension is the base's portion, so tuning the base moves
// the whole estimate and the per-defect share keeps its proportion.
export function preTripSimDays(defectCount) {
  const extra = Math.max(0, defectCount) * PRE_TRIP_SIM_DAYS / 2
  return PRE_TRIP_SIM_DAYS + extra
}

// ---------------------------------------------------------------------
// The inspection itself
// ---------------------------------------------------------------------
//
// `truck` is the row as it stands BEFORE the run: odometer and the tread
// gauges. `lastDvir` is the most recent report for this truck (dvir.sql.js's
// LATEST_FOR_TRUCK_SQL shape: { defects, defectsCorrected, ... }), or null
// when the truck has never run -- a freshly bought truck has no last
// report, and 396.13 asks nothing of a driver with nothing to review.

// The thresholds are dvir.js's own -- re-used, not restated. A pre-trip
// finding a tire at 24% while the report's own rule calls 25% a defect
// would be two laws for one truck.
export { TIRE_DEFECT_THRESHOLD_PCT, TIRE_WEAR_NOTE_THRESHOLD_PCT }

// The independent small items, read the way the post-trip reads them:
// these fail rarely, and never all at once. `rng` is injected -- the
// dispatch passes dvirRngFor(load.id)'s sibling, so the same dispatch
// retried after a crash produces the same walk-around. THE REST of the
// inspection is deterministic in the truck's gauges.
export const SMALL_FAILURE_RATE = 0.03

// 392.7's inspection. Returns the outcome the dispatch writes:
//   items          -- every PRE_TRIP_ITEM_KEYS entry, true (checked, ok)
//                     or false (defect found)
//   defects        -- [{ item, detail }], the write-down the rule requires
//                     when the walk-around finds something
//   notes          -- wear observations that hold nothing (same split
//                     seedReport keeps: a note is not a defect)
//   minutes        -- sim days the walk-around occupies, from
//                     preTripSimDays(defects.length)
//   dvirReview     -- certificationDecision(lastDvir) verbatim: the
//                     396.13 review the walk-around begins with. A report
//                     listing defects nobody certified makes allowed false
//                     -- that is the line the dispatcher reads BEFORE the
//                     truck moves, and the fact the outcome tracks.
export function inspectionOutcome({ truck, lastDvir, rng }) {
  const defects = []
  const notes = []

  const items = {}
  for (const item of PRE_TRIP_ITEM_KEYS) items[item] = true

  // Tires, off the gauges -- the same reading the post-trip writes and
  // this inspection starts from. Below the defect threshold the item
  // fails and 396.13's rule names the consequence; between the thresholds
  // the wear is a note for the next service decision, not a failed item.
  if (truck.tireFrontPct < TIRE_DEFECT_THRESHOLD_PCT || truck.tireRearPct < TIRE_DEFECT_THRESHOLD_PCT) {
    items.tires = false
    defects.push({
      item: 'tires',
      detail: truck.tireFrontPct < truck.tireRearPct
        ? `Steer tread below ${TIRE_DEFECT_THRESHOLD_PCT}%`
        : `Drive tread below ${TIRE_DEFECT_THRESHOLD_PCT}%`,
    })
  } else if (truck.tireFrontPct < TIRE_WEAR_NOTE_THRESHOLD_PCT || truck.tireRearPct < TIRE_WEAR_NOTE_THRESHOLD_PCT) {
    notes.push({
      item: 'tires',
      detail: `Tread below ${TIRE_WEAR_NOTE_THRESHOLD_PCT}% -- schedule replacement`,
    })
  }

  // The independent small items -- the only dice the walk-around rolls,
  // loaded the way inspections land: mostly nothing. Brakes, steering,
  // coupling, lights and the two 392.7 extensions are never dice: they
  // are either proven by a gauge or they are fine.
  const SMALL_ITEMS = ['horn', 'wipers', 'mirrors', 'emergencyEq']
  if (rng) {
    for (const key of SMALL_ITEMS) {
      if (rng() < SMALL_FAILURE_RATE) {
        items[key] = false
        defects.push({ item: key, detail: 'Not working at the pre-trip walk-around' })
      }
    }
  }

  // 396.13(b): the walk-around BEGINS with the last report. The rule is
  // dvir.js's own -- if it lists defects nobody certified, the review
  // fails, and that fact rides the outcome wherever the inspection's own
  // findings ride. A truck with no reports yet reviews nothing.
  const dvirReview = certificationDecision(lastDvir)

  return {
    items,
    defects,
    notes,
    minutes: preTripSimDays(defects.length),
    dvirReview,
  }
}

// The ELD block the walk-around occupies: on-duty-not-driving, 395.8's
// fourth status. It ends where the driving it precedes begins -- by
// default the dispatch itself (the load's own log starts there), or, when
// the truck has a repositioning drive to run first, that drive's start:
// the walk-around happens BEFORE the wheels move (392.7's "prior to
// operating the vehicle"), the repositioning IS the wheels moving, and
// the two must never overlap on the same truck.
//
// On the COMPRESSED calendar: duty_events lives on sim days, so a literal
// 30 sim-minute walk-around is preTripSimDays() * REAL_MS_PER_SIM_DAY of
// real time. Returns { status, startedAt, endedAt } or null when there is
// nothing to record (an unusable time -- no invented block).
export function preTripBlock({ dispatchedAt, defectCount = 0, endsAt = null }) {
  const endRaw = endsAt ?? dispatchedAt
  const endMs = new Date(endRaw).getTime()
  if (!Number.isFinite(endMs)) return null

  const spanMs = preTripSimDays(defectCount) * REAL_MS_PER_SIM_DAY
  return {
    status: 'on-duty-not-driving',
    startedAt: new Date(endMs - spanMs),
    endedAt: new Date(endMs),
  }
}

// The row the dispatch transaction writes, from the outcome and the facts
// it already holds. Pure input, pure output -- the same seam dvir.service.js's
// buildReportRow keeps: the transaction does the writing, a test can build
// the row against a fixture and inspect it without a database.
export function buildInspectionRow({ truckId, driverId, loadId, odometerMi, outcome, reviewedDvirId = null }) {
  return {
    truckId,
    driverId: driverId ?? null,
    loadId: loadId ?? null,
    odometerMi,
    brakesOk: outcome.items.brakes,
    lightsOk: outcome.items.lights,
    tiresOk: outcome.items.tires,
    steeringOk: outcome.items.steering,
    couplingOk: outcome.items.coupling,
    hornOk: outcome.items.horn,
    wipersOk: outcome.items.wipers,
    mirrorsOk: outcome.items.mirrors,
    emergencyEqOk: outcome.items.emergencyEq,
    parkingBrakeOk: outcome.items.parkingBrake,
    wheelsRimsOk: outcome.items.wheelsRims,
    defects: outcome.defects,
    reviewedDvirId,
  }
}

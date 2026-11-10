// Dispatching a load, and the tick that finishes one.
//
// This is the half of the simulator that did not exist until now. A load
// created by accepting a rate confirmation sat at 'neutral' with no way
// out: nothing assigned it, nothing delivered it, nothing invoiced it. So
// cash could only ever drain. These two pieces close the loop --
// dispatch starts the clock, the tick finishes the run and pays for it.
import { withTransaction, pool } from '../../db/pool.js'
import config from '../../config.js'
import { AppError } from '../../lib/errors.js'
import * as loadsRepo from './loads.repository.js'
import * as cash from '../cash/cash.service.js'
import * as cashRepo from '../cash/cash.repository.js'
import * as trucksRepo from '../fleet/trucks.repository.js'
import * as metricsRepo from '../fleet/metrics.repository.js'
import * as maintenanceRepo from '../fleet/maintenance.repository.js'

// How many loads or invoices one tick will process. The tick runs every
// 30 seconds, so a backlog drains quickly; a cap keeps one tick bounded.
const MAX_PER_TICK = 25
import {
  simDaysToSeconds,
  financeDaysToSeconds,
  simDaysToMs,
  billableSimDays,
  droppedGapSeconds,
  interestForPeriodExactTiered,
} from '../../constants/simClock.js'
import { TERM_DAYS } from '../../constants/paymentTerms.js'
import { FUEL_PRICE_PER_GAL, AVG_MPG, MONTHLY_INSURANCE } from '../finance/finance.constants.js'
import { settlementFor, SETTLEMENT_TERM_SIM_DAYS } from '../../constants/driverPay.js'
import * as payrollRepo from '../payroll/payroll.repository.js'
import { chargeTruckLeases } from '../fleet/truckLease.service.js'
import * as availabilityService from '../availability/availability.service.js'
import { REASONS } from '../../constants/availabilityReasons.js'
import { postRefusal } from '../driverChat/driverChat.refusalPost.js'
import { rollEvents } from '../loadEvents/loadEvents.service.js'
import {
  gallonsFor, fuelCostForGallons, splitTankAndPump, tirePointsWorn, serviceDueMileage,
  allocateRunDays, splitGallons, walkFuelPct,
  OIL_SERVICE_INTERVAL_MI, OIL_SERVICE_LABEL,
  TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI, DAILY_DISTANCE_CAP_MI,
} from '../../constants/truckWear.js'
import { SIM_TODAY_SQL } from '../fleet/fleet.sql.js'
import { planStops, describeWarning } from '../facilities/stopPlan.js'
import * as facilitiesService from '../facilities/facilities.service.js'
import * as routingRepo from '../routing/routing.repository.js'
import * as stopVisitsRepo from '../facilities/stopVisits.repository.js'
import * as dutyEventsRepo from '../hos/dutyEvents.repository.js'
import { repositioningBlock } from '../hos/repositioning.js'
import { buildReportRow } from '../fleet/dvir.service.js'
import * as dvirRepo from '../fleet/dvir.repository.js'
import { inspectionOutcome, preTripBlock, buildInspectionRow } from '../../constants/preTrip.js'
import * as preTripRepo from '../fleet/preTrip.repository.js'

// The DVIR seed rolls which of the small inspection items failed this
// run. A tick must be REPRODUCIBLE: the same delivery retried after a
// crash must write the same report, so the seed is the load id hashed
// (FNV-1a) -- not Math.random, which would make the log depend on when
// the process restarted, and not a shared counter, which would make
// report N depend on report N-1.
function dvirRngFor(loadId) {
  let h = 0x811c9dc5
  for (let i = 0; i < loadId.length; i += 1) {
    h ^= loadId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let a = h >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
import { fromHosDomain, driverHosSnapshot, HOS_LOOKBACK_HOURS } from '../../constants/hosClock.js'
import * as complianceService from '../compliance/compliance.service.js'
import { readPreferences, hasRequests, preferenceConflicts, avoidedPlaces } from '../../constants/driverPreferences.js'
import { deliveredTo, emptyRunCheck, placeLabel } from './whereabouts.js'
import { undoDispatch } from './loadWithdrawal.js'

// How long the run takes, in simulated days, from the window the broker
// promised. Floored at half a day so a short local run still has a
// visible transit rather than arriving the instant it is dispatched.
export function transitDaysFor({ pickupAt, deliveryAt }) {
  const ms = new Date(deliveryAt) - new Date(pickupAt)
  const days = ms / 86400000
  return Math.max(0.5, Number.isFinite(days) ? days : 1)
}

// delayFactor is gone, and this note is why.
//
// It rolled a load's delay at DISPATCH: eta_at was promised * factor, the
// number was decided before the truck moved, and nothing ever said what
// caused it. That was an improvement on what came before it (a load could
// not be late at all), but it left the student watching a load slide to
// 'crit' with no cause to look at and nothing to do -- there was no
// visible reason for the lateness, only a die roll at t=0.
//
// There are now TWO real reasons a load can run late, and both say why.
//
// Delay comes from load_events -- weather, a breakdown, detention, a
// closed road. The driver calls it in, the dispatcher chooses how to
// handle it, and eta_at moves because of that choice. See
// src/constants/loadEvents.js. About one load in five still meets
// something, the same rate delayFactor produced; the difference is that
// the fifth load now has a reason and a decision in it.
//
// Delay ALSO comes from the law, before the truck has met anything at
// all: facilities/stopPlan.js runs the dispatched route against 49 CFR
// 395's hours-of-service rules (src/constants/hosClock.js) and returns
// legalArrivalAt -- when the run can ACTUALLY finish once the mandatory
// breaks and 10-hour resets are accounted for. planAndSaveStops below
// writes that onto eta_at once it is known. promised_eta_at is never
// touched by either path -- it is what the broker was told, and an event
// or a legal schedule does not renegotiate it -- so eta_at > promised_eta_at
// is exactly the gap markLate already watches for (loads.repository.js),
// now with a second, entirely legitimate cause behind it: a broker's
// promised transit time that HOS never actually allowed in the first
// place. That is a fact about the lane, not a verdict on the dispatcher
// who booked it.

export function fuelCostFor(distanceMi) {
  return Math.round((distanceMi / AVG_MPG) * FUEL_PRICE_PER_GAL)
}

// ---------------------------------------------------------------------
// Pre-dispatch compliance check -- what the confirm window shows
// ---------------------------------------------------------------------

// The driver's own requests against this lane (drivers.preferences, 054),
// as one dispatch-check line. 'warn', never 'fail': a request is the
// driver's, the decision is the dispatcher's, and the driver will say
// what she thinks if she is sent anyway (driverChat.prompt.js). No line
// at all for a driver who has asked for nothing -- an "ok" there would
// read as a check that something was cleared.
export function preferenceCheck(driverRow, load) {
  if (!driverRow) return null
  const prefs = readPreferences(driverRow.preferences)
  if (!hasRequests(prefs)) return null
  const conflicts = preferenceConflicts(prefs, load)
  return {
    key: 'preferences',
    state: conflicts.length > 0 ? 'warn' : 'ok',
    label: "Driver's requests",
    detail: conflicts.length > 0
      ? `${driverRow.name} has asked not to run to ${conflicts.map((c) => `${c.place} (${c.end})`).join(' or ')}`
        + (prefs.why ? `. ${prefs.why}` : '')
      : `Nothing on this lane ${driverRow.name} has asked to avoid (${avoidedPlaces(prefs).join(', ')})`,
    cfr: null,
  }
}

// GET /loads/:id/dispatch-check?driverId=... -- the facts a dispatcher
// sees BEFORE dispatching, gathered from the same sources the dispatch
// itself will read. Nothing here blocks: expired paperwork, an empty
// drive clock and an empty truck all appear as named lines, and the
// student decides (the refusal, if the driver then says no, still comes
// from the driver -- see dispatchLoadInner). Rows the reader could not
// produce travel as degraded entries, never as all-clear.
export async function dispatchCheck({ loadId, driverId }, opts = {}) {
  // opts.client: the same seam stats.service.js's overview takes -- a test's
  // rollback transaction reads its own uncommitted fixture through it, the
  // pool path stays the one-shot default every route hits.
  const client = opts.client ?? null
  const degraded = []
  async function collect(label, fn) {
    try {
      return await fn()
    } catch (err) {
      console.error(`[dispatch-check] ${label} failed:`, err.message)
      degraded.push(label)
      return null
    }
  }

  const load = await loadsRepo.getLoadById(loadId, client)
  if (!load) throw new AppError('LOAD_NOT_FOUND')
  if (load.status !== 'neutral') throw new AppError('LOAD_NOT_DISPATCHABLE')

  const [driverRow, dq, availability] = await Promise.all([
    // The SAME read the dispatch write makes (getDriverForDispatch) --
    // truck, drive clock and active-load count in one shape. A hand-rolled
    // SELECT here once forgot the active-load count and the workload line
    // read 'unknown' forever.
    collect('driver', () => loadsRepo.getDriverForDispatch(client ?? pool, driverId)),
    collect('driverQualification', () =>
      (driverId
        ? complianceService.listDriverQualification({ client }).then((r) => {
            // The driver's file travels WITH the shared document-type
            // catalogue -- the line reader below names each document from
            // the same list the Qualification screen does, not its own.
            const found = r.drivers.find((d) => d.driver.id === driverId) ?? null
            return found ? { ...found, documentTypes: r.documentTypes } : null
          })
        : Promise.resolve(null))),
    collect('availability', () =>
      (driverId ? availabilityService.driverAvailability(client, driverId) : Promise.resolve(null))),
  ])

  if (driverId && !driverRow) throw new AppError('DRIVER_NOT_FOUND')

  // The transit estimate the broker's window implies -- the same number
  // dispatchLoadInner will start from. The stop planner may move the legal
  // arrival later; this line is the promise side only, labelled as such.
  // pickup_at/delivery_at come from the posting on the real calendar and
  // exist from the moment the load is booked, dispatched or not.
  const transitDays = load.pickupAt == null || load.deliveryAt == null
    ? null
    : transitDaysFor({ pickupAt: load.pickupAt, deliveryAt: load.deliveryAt })

  const checks = []

  // CDL + medical + MVR + drug & alcohol, one line per document, each
  // already timed by the qualification reader (the SAME reading the
  // Qualification screen shows -- the check never has a second opinion).
  for (const doc of dq?.documents ?? []) {
    const def = dq.documentTypes.find((t) => t.key === doc.type)
    checks.push({
      key: `dq.${doc.type}`,
      state: doc.status === 'valid' ? 'ok' : (doc.status === 'expiring' ? 'warn' : 'fail'),
      label: def?.label ?? doc.type,
      detail: doc.status === 'expiring'
        ? `Renewal due in ${doc.daysLeft} company days`
        : doc.status === 'valid' ? null : 'Not current -- the next audit asks about this',
      cfr: def?.cfr ?? null,
    })
  }
  if (dq == null) {
    checks.push({ key: 'dq', state: 'unknown', label: 'Driver qualification', detail: 'Could not be read', cfr: null })
  }

  // Truck: dispatch cannot run without one (the dispatch will refuse with
  // DRIVER_HAS_NO_TRUCK; here it is a visible line before the click).
  checks.push({
    key: 'truck',
    state: driverRow?.truckId ? 'ok' : 'fail',
    label: 'Truck',
    detail: driverRow?.truckId
      ? `${driverRow.truckMake ?? ''} ${driverRow.truckModel ?? ''}`.trim() || driverRow.truckId
      : 'No truck assigned -- buy one on the truck market, then assign it',
    cfr: null,
  })

  // Workload: one active load per driver is a database rule (007), not a
  // policy -- it fails before the confirm click for the same reason.
  checks.push({
    key: 'workload',
    state: driverRow && driverRow.activeLoads == null ? 'unknown' : (driverRow && driverRow.activeLoads > 0 ? 'fail' : 'ok'),
    label: 'Current workload',
    detail: driverRow && driverRow.activeLoads > 0 ? 'Already running a load' : null,
    cfr: null,
  })

  // The driver's willingness, asked the way dispatch will ask it. A refusal
  // here is the driver's own decision, not a compliance failure -- the line
  // says what the driver says, the check does not vote on it.
  if (availability && !availability.available) {
    checks.push({
      key: 'willingness',
      state: 'fail',
      label: 'Driver status',
      detail: availability.reason === REASONS.QUIT
        ? 'This driver no longer works here'
        : `Not accepting new loads -- owed $${(availability.standing?.owedUsd ?? 0).toLocaleString('en-US')}`,
      cfr: null,
    })
  } else if (availability) {
    checks.push({ key: 'willingness', state: 'ok', label: 'Driver status', detail: null, cfr: null })
  }

  // HOS: the raw clock the driver brings to the run. The planner decides
  // what fits; the dispatcher reads the number against the trip estimate.
  checks.push({
    key: 'hos',
    state: driverRow?.hosRemainingMin == null ? 'unknown' : (driverRow.hosRemainingMin <= 0 ? 'warn' : 'ok'),
    label: 'Drive time available',
    detail: driverRow?.hosRemainingMin == null
      ? null
      : `${Math.floor(driverRow.hosRemainingMin / 60)}h ${driverRow.hosRemainingMin % 60}m on the 11-hour clock`,
    cfr: '49 CFR 395.3(a)(3)',
  })

  // Pre-trip inspection (49 CFR 392.7 + 396.13): the walk-around the
  // driver is ABOUT to perform, shown as the facts it will start from.
  // The outcome comes from the SAME rule the dispatch transaction will
  // write -- one opinion, not two. A truck with no assigned driver has no
  // walk-around to speak of: no line, not a guessed one. The line never
  // blocks: the walk-around itself will find what it finds, and the
  // last-DVIR review (396.13(b)(2)) is a fact the dispatcher weighs.
  if (driverRow?.truckId) {
    const [truck, lastDvir] = await Promise.all([
      collect('preTripTruck', () => trucksRepo.getTruckById(driverRow.truckId, client)),
      collect('preTripDvir', () => dvirRepo.latestForTruck(driverRow.truckId, client)),
    ])
    if (truck) {
      const outcome = inspectionOutcome({
        truck: { odometerMi: truck.odometerMi, tireFrontPct: truck.tireFrontPct, tireRearPct: truck.tireRearPct },
        lastDvir,
        // No rng here: the check is a READ and must not spend the seed
        // the dispatch write will roll -- and the deterministic parts
        // (the gauges) are exactly the parts worth showing.
        rng: null,
      })
      const hasDefect = Object.values(outcome.items).some((ok) => !ok)
      checks.push({
        key: 'preTrip',
        state: hasDefect ? 'fail' : (outcome.dvirReview.allowed ? 'ok' : 'warn'),
        label: 'Pre-trip inspection',
        detail: hasDefect
          ? outcome.defects.map((d) => d.detail).join('; ')
          : outcome.dvirReview.allowed
            ? 'Walk-around checks out from the truck\'s gauges'
            : outcome.dvirReview.reason,
        cfr: outcome.dvirReview.allowed ? '49 CFR 392.7' : '49 CFR 396.13(b)(2)',
      })
    }
  }

  const requests = preferenceCheck(driverRow, load)
  if (requests) checks.push(requests)

  // How far the empty truck has to come to the pickup. Missing before
  // 2026-10-05: a driver in Seattle was dispatched to Nashville and the
  // check said nothing about 2,400 empty miles.
  const emptyRun = emptyRunCheck(driverRow, load)
  if (emptyRun) checks.push(emptyRun)

  const canDispatch = checks.every((c) => c.state !== 'fail')

  return {
    load: {
      id: load.id,
      originLabel: `${load.originCity}, ${load.originState}`,
      destinationLabel: `${load.destinationCity}, ${load.destinationState}`,
      distanceMi: load.distanceMi,
      rateUsd: load.rateUsd,
    },
    driver: driverRow ? { id: driverRow.id, name: driverRow.name } : null,
    transitDays,
    transitSource: 'promised',
    checks,
    canDispatch,
    degraded,
  }
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

export async function dispatchLoad({ loadId, driverId, userId }) {
  try {
    const dispatched = await dispatchLoadInner({ loadId, driverId, userId })
    // Best-effort, AFTER the dispatch's own transaction has committed --
    // never inside it. A stop-planning failure (no cached route, no
    // facility nearby, a malformed geometry) must not roll back a
    // dispatch that already succeeded, and running it inside that
    // transaction risks exactly that even with a local try/catch:
    // Postgres marks a transaction aborted on its first failing
    // statement regardless of whether JS caught the error. This is the
    // "yuk baribir dispatch bo'lsin" requirement, structurally --
    // nothing this call does can undo the dispatch above it.
    await planAndSaveStops(dispatched).catch(async (err) => {
      // Said on the load itself (loads.stop_plan_status/facts, 037), where
      // the dispatcher's own screens read it -- not only in a server log.
      // Only if even THAT write fails is the console the last place left.
      await loadsRepo.setStopPlanOutcome(pool, {
        loadId,
        status: 'failed',
        facts: [{
          code: 'STOP_PLAN_FAILED',
          cfr: null,
          detail: `Stop planning failed (${err.message}). The load is dispatched; no fuel or rest stops `
            + 'were planned and the ETA is the broker\'s transit estimate, not the HOS-legal one.',
        }],
      }).catch((writeErr) => {
        console.error(`[dispatch] load ${loadId}: stop planning failed (${err.message}) and so did recording that (${writeErr.message})`)
      })
    })
    return dispatched
  } catch (err) {
    // getDriverForDispatch is an unlocked SELECT, so two dispatches of two
    // different loads to the same driver both pass the pre-flight check.
    // loads_one_active_per_driver_idx (migration 007) catches the second
    // one; without this it surfaced as INTERNAL_ERROR even though the
    // right code has existed since the board was built.
    if (err.code === '23505' && err.constraint === 'loads_one_active_per_driver_idx') {
      throw new AppError('DRIVER_HAS_ACTIVE_LOAD')
    }

    // A refusal is a thing a person said, so it goes in the conversation
    // with that person rather than only into a red line under a dropdown.
    //
    // AFTER the transaction, not inside it: the dispatch transaction is
    // rolling back regardless, and a chat write enlisted in it would roll
    // back with it -- the driver would have refused and said nothing. It
    // is also fire-and-forget: failing to post the line must not change
    // what the dispatcher is told about the dispatch itself.
    if (err instanceof AppError && (err.code === 'DRIVER_REFUSED_WORK' || err.code === 'DRIVER_QUIT')) {
      await postRefusal({ userId, details: err.details, code: err.code })
        .catch((e) => console.error('[dispatch] could not post refusal to chat:', e.message))
    }

    throw err
  }
}

async function dispatchLoadInner({ loadId, driverId, userId }) {
  return withTransaction(async (client) => {
    const load = await loadsRepo.getLoadById(loadId, client)
    if (!load) throw new AppError('LOAD_NOT_FOUND')
    if (load.status !== 'neutral') throw new AppError('LOAD_NOT_DISPATCHABLE')

    const driver = await loadsRepo.getDriverForDispatch(client, driverId)
    if (!driver) throw new AppError('DRIVER_NOT_FOUND')
    // A driver without a truck cannot run freight. Stated plainly rather
    // than hidden behind a filtered dropdown -- the student should see
    // that hiring and buying are two separate decisions.
    if (!driver.truckId) throw new AppError('DRIVER_HAS_NO_TRUCK')
    if (driver.activeLoads > 0) throw new AppError('DRIVER_HAS_ACTIVE_LOAD')

    // Will this person take the load?
    //
    // Asked inside the transaction so the answer cannot be stale -- a
    // payroll run that landed a second ago has already changed it. Nothing
    // about the driver's willingness is stored in a column: a stored
    // answer would have to be recomputed on every payment and every tick,
    // and a stale one would have somebody refusing work over money they
    // had already been paid.
    //
    // The refusal is a fact about a person, not a rule the system is
    // enforcing. The dispatcher was allowed to try, and the reason arrives
    // in the driver's own words -- see the catch in dispatchLoad.
    const availability = await availabilityService.driverAvailability(client, driverId)
    // Details on this one too, or postRefusal has no driver id and the
    // person who left says nothing at all in the thread.
    if (availability.reason === REASONS.QUIT) {
      throw new AppError('DRIVER_QUIT', {
        driverId, driverName: driver.name, reason: REASONS.QUIT,
        owedUsd: availability.standing.owedUsd,
        daysOverdue: availability.standing.daysOverdue,
      })
    }
    if (!availability.available) {
      // The reason travels with the refusal. errorHandler ships details
      // for this code in production too -- see CODES_WITH_PUBLIC_DETAILS
      // -- because "not accepting work right now" without the numbers is a
      // person's decision with its reason removed.
      throw new AppError('DRIVER_REFUSED_WORK', {
        driverId,
        driverName: driver.name,
        reason: availability.reason,
        owedUsd: availability.standing.owedUsd,
        daysOverdue: availability.standing.daysOverdue,
        unpaidCount: availability.standing.unpaidCount,
      })
    }

    // The promise is what the broker was told; the ETA is what the road
    // is going to do. They are allowed to differ, and that difference is
    // the only reason a load can ever be late.
    // The ETA starts equal to the promise. There is nothing to know yet:
    // a run that meets nothing arrives when it said it would, and every
    // hour it slips is an event the dispatcher watched happen.
    const promisedDays = transitDaysFor(load)
    const actualDays = promisedDays
    const dispatched = await loadsRepo.dispatchLoad(client, {
      loadId,
      driverId,
      truckId: driver.truckId,
      etaSeconds: simDaysToSeconds(actualDays),
      // The same window on the same clock, without the delay. This is
      // what "on time" means for this load, and it is the only thing the
      // ETA can honestly be measured against.
      promisedSeconds: simDaysToSeconds(promisedDays),
    })
    // 0 rows means something took it between the read above and here.
    if (!dispatched) throw new AppError('LOAD_NOT_DISPATCHABLE')

    await loadsRepo.setDriverDriving(client, { driverId })

    return {
      load: dispatched,
      driver: { id: driver.id, name: driver.name },
      truckId: driver.truckId,
      transitDays: actualDays,
    }
  })
}

// ---------------------------------------------------------------------
// Stop planning -- fuel and rest stops for the run just dispatched
// ---------------------------------------------------------------------
//
// Runs AFTER dispatchLoadInner's own transaction commits (see
// dispatchLoad's own comment on why) -- its own read of the load's route
// and the truck's tank, its own writes, in a transaction of its own.
// Nothing here can undo the dispatch; the worst outcome is a load with no
// stop plan and eta_at left at the old, non-HOS-aware estimate -- and
// that outcome is written onto the load (stop_plan_status/facts, 037),
// never only logged and never thrown.
//
// Ordering: eta_at CANNOT be set inside dispatchLoadInner's own
// transaction, and this is the second, sharper reason (past the
// Postgres-transaction-poisoning one dispatchLoad's own comment already
// gives): the legal arrival planStops computes depends on primary.geometry
// (a cache READ against routing.repository.js) and the truck's own tank
// state, neither of which dispatchLoadInner reads. Computing them inside
// that transaction would mean holding it open across two more reads for a
// number the dispatch itself does not need to succeed. So eta_at is
// written here, in its OWN follow-up statement (loadsRepo.setLegalEtaAt),
// after stop planning has actually produced a legal arrival -- a second
// write to a row already committed, guarded the same way
// loadEvents.sql.js's EXTEND_ETA_SQL guards its own eta_at update
// (dispatched, not yet delivered), so a load that raced ahead in the gap
// is left with whatever eta_at it already has rather than being
// overwritten against a run that has moved on.
//
// dutyTimeline is persisted to duty_events (037) in the same transaction
// as the stop visits -- the driver's ELD log for this run, planned once,
// read back by the tick's syncDriverHos and by the NEXT dispatch's own
// planStops call (priorDutyEvents), so hours carry from load to load.
async function planAndSaveStops({ load, driver, truckId }) {
  const lane = {
    origin: { city: load.originCity, state: load.originState },
    destination: { city: load.destinationCity, state: load.destinationState },
  }
  const laneText = `${lane.origin.city}, ${lane.origin.state} -> ${lane.destination.city}, ${lane.destination.state}`
  const outcome = (status, facts) => loadsRepo.setStopPlanOutcome(pool, { loadId: load.id, status, facts })
  const NOT_HOS_ETA = 'No fuel or rest stops were planned and the ETA is the broker\'s transit estimate, not the HOS-legal one.'

  // Cache read ONLY -- routing.repository.js's getRoutes, never
  // routing.service.js's routesFor. A load dispatches whether or not
  // OSRM has ever been asked about this lane; asking it NOW would make
  // dispatch depend on a network call to a third party, which no other
  // write path in this codebase does.
  const routes = await routingRepo.getRoutes(lane)
  const primary = routes.find((r) => r.alternativeIndex === 0)
  if (!primary) {
    // The command is for whoever runs the server, so it goes to the log.
    // It was in the fact text until 2026-10-08, and the fact text is what a
    // student reads on the load's Trip plan.
    console.warn(`[dispatch] no cached route for ${laneText} -- npm run routes:warm fills it`)
    await outcome('no-route', [{
      code: 'NO_CACHED_ROUTE',
      cfr: null,
      detail: `No road route is known for ${laneText} yet. ${NOT_HOS_ETA}`,
    }])
    return
  }

  const truck = await trucksRepo.getTruckById(truckId)
  if (!truck) {
    await outcome('no-truck', [{
      code: 'TRUCK_NOT_FOUND', cfr: null, detail: `Truck ${truckId} was not found. ${NOT_HOS_ETA}`,
    }])
    return
  }

  // Every known facility -- stopPlan.js does its own corridor filtering
  // (perpMi <= ROUTE_CORRIDOR_MI), so nothing needs to be pre-filtered by
  // geography here.
  const facilities = await facilitiesService.listAll()

  // The driver's own recent log. Without it every load started on a fresh
  // 11 hours no matter what the driver did an hour ago, and the 60/70-hour
  // weekly limits could never accumulate across loads.
  const dispatchedMs = new Date(load.dispatchedAt).getTime()
  const priorDutyEvents = await dutyEventsRepo.recentForDriver(pool, {
    driverId: driver.id,
    since: new Date(dispatchedMs - simDaysToMs(HOS_LOOKBACK_HOURS / 24)),
  })

  const { stops, dutyTimeline, legalArrivalAt, hosFacts, warnings } = planStops({
    routeGeometry: primary.geometry,
    distanceMi: load.distanceMi,
    startFuelGallons: truck.fuelGallons,
    fuelCapacityGal: truck.fuelCapacityGal,
    facilities,
    dispatchedAt: load.dispatchedAt,
    promisedEtaAt: load.promisedEtaAt,
    priorDutyEvents,
  })

  // Facts, not verdicts (BOSS/coder rule): legal reasons the run takes as
  // long as it does -- including, when it applies, that the broker's
  // promised window never fit the law -- plus anything the planner could
  // not do (warnings), all stored on the load. No AppError, no block: the
  // dispatch already happened.
  const facts = [
    ...hosFacts,
    ...warnings.map((w) => ({ code: w.code, cfr: null, detail: describeWarning(w) })),
  ]

  if (!legalArrivalAt) {
    await outcome('no-legal-arrival', [...facts, {
      code: 'NO_LEGAL_ARRIVAL', cfr: null, detail: `The planner produced no arrival time. ${NOT_HOS_ETA}`,
    }])
    return
  }

  // dutyTimeline is in literal hours around dispatchedMs (stopPlan.js's
  // two-clocks header); duty_events lives on the compressed calendar.
  const dutyRows = fromHosDomain(dutyTimeline, dispatchedMs).map((e) => ({
    driverId: driver.id,
    loadId: load.id,
    truckId,
    status: e.status,
    startedAt: new Date(e.startedAt),
    endedAt: new Date(e.endedAt),
    routeOffsetMi: e.routeOffsetMi,
    facilityId: e.facilityId,
  }))

  // Getting the empty truck here. The planner's log starts at the ORIGIN,
  // so if the truck finished its last run somewhere else, the drive in
  // between is in nobody's log -- which on a real ELD is exactly what an
  // unidentified driving record is (49 CFR 395.32). It is written with no
  // driver and the truck's id; Compliance > Unassigned HOS is where a
  // person decides whose time it was. hos/repositioning.js has the
  // reasoning and the numbers.
  //
  // Computed outside the transaction (pure), written inside it: a
  // dispatch whose log is saved but whose repositioning is not would be
  // the same half-fact the plan/eta pair is careful to avoid.
  const reposition = repositioningBlock({
    truckLocationLabel: truck.currentLocation,
    originCity: load.originCity,
    originState: load.originState,
    dispatchedAt: load.dispatchedAt,
  })

  // The walk-around the driver performs BEFORE the wheels move (49 CFR
  // 392.7 -- pre-trip is on-duty-not-driving time). The repositioning
  // drive, when there is one, IS the wheels moving: the walk-around ends
  // where that drive begins, never overlapping it on the same truck.
  // Without one it ends at the dispatch, where the load's own log begins.
  // Computed pure from the truck as it stands at dispatch, written inside
  // the same transaction as everything else this planning writes. The
  // reviewed DVIR rides the row as 396.13(b)(1)'s proof: the walk-around
  // begins with the last report, and the row says which one was read.
  const ptiRng = dvirRngFor(`pti:${load.id}`)
  const lastDvir = await dvirRepo.latestForTruck(truckId)
  const ptiOutcome = inspectionOutcome({
    truck: { odometerMi: truck.odometerMi, tireFrontPct: truck.tireFrontPct, tireRearPct: truck.tireRearPct },
    lastDvir,
    rng: ptiRng,
  })
  const ptiBlock = preTripBlock({
    dispatchedAt: load.dispatchedAt,
    defectCount: ptiOutcome.defects.length,
    endsAt: reposition ? reposition.startedAt : load.dispatchedAt,
  })
  // The row shape the transaction writes -- built here, next to the
  // outcome it comes from, so the transaction only does the writing.
  const ptiRow = buildInspectionRow({
    truckId,
    driverId: driver.id,
    loadId: load.id,
    odometerMi: truck.odometerMi,
    outcome: ptiOutcome,
    reviewedDvirId: lastDvir?.id ?? null,
  })

  await withTransaction(async (client) => {
    await dutyEventsRepo.insertMany(client, dutyRows)
    if (reposition) {
      await dutyEventsRepo.insertUnidentified(client, {
        loadId: load.id,
        truckId,
        startedAt: reposition.startedAt,
        endedAt: reposition.endedAt,
      })
    }
    // The walk-around block: ends where the driving it precedes begins
    // (the repositioning's start, or the dispatch itself) -- never
    // overlapping the drive on the same truck. The unique index
    // duty_events_one_active_start makes a re-dispatch's duplicate a
    // no-op, not a second copy of the log.
    if (ptiBlock) {
      await dutyEventsRepo.insertMany(client, [{
        driverId: driver.id,
        loadId: load.id,
        truckId,
        status: ptiBlock.status,
        startedAt: ptiBlock.startedAt,
        endedAt: ptiBlock.endedAt,
      }])
    }
    if (ptiOutcome.defects.length > 0 || !ptiOutcome.dvirReview.allowed) {
      // The facts the dispatcher will read on the load (stop_plan_facts,
      // 037): a finding the walk-around made, and the 396.13 review that
      // refused. No AppError, no block -- the dispatch stands, the
      // consequence is written where it can be read.
      const ptiFacts = []
      if (ptiOutcome.defects.length > 0) {
        ptiFacts.push({
          code: 'PRE_TRIP_DEFECTS',
          cfr: '49 CFR 392.7',
          detail: `The pre-trip walk-around found ${ptiOutcome.defects.length} defect${ptiOutcome.defects.length === 1 ? '' : 's'}: `
            + ptiOutcome.defects.map((d) => d.detail).join('; '),
        })
      }
      if (!ptiOutcome.dvirReview.allowed) {
        ptiFacts.push({
          code: 'PRE_TRIP_DVIR_REVIEW',
          cfr: ptiOutcome.dvirReview.cfr,
          detail: `${ptiOutcome.dvirReview.reason} -- certify it on Fleet > DVIR before this truck runs.`,
        })
      }
      await loadsRepo.appendStopPlanFacts(client, { loadId: load.id, facts: ptiFacts })
    }
    // The inspection row itself, through the table's one writer.
    if (ptiRow) {
      await preTripRepo.insertInspection(client, ptiRow)
    }
    if (stops.length > 0) {
      await stopVisitsRepo.insertMany(client, stops.map((s) => ({
        loadId: load.id,
        truckId,
        driverId: driver.id,
        facilityId: s.facilityId,
        reason: s.reason,
        routeOffsetMi: s.routeOffsetMi,
        arrivedAt: s.arrivedAt,
        departedAt: s.departedAt,
        gallons: s.gallons,
        costUsd: s.costUsd,
      })))
    }
  })

  const updated = await loadsRepo.setLegalEtaAt(pool, { loadId: load.id, legalArrivalAt })
  if (!updated) {
    facts.push({
      code: 'ETA_NOT_UPDATED',
      cfr: null,
      detail: 'The load was delivered or cancelled before planning finished, so its ETA was left as it was.',
    })
  }
  await outcome('planned', facts)
}

// ---------------------------------------------------------------------
// What a delivered run does to the truck that pulled it
// ---------------------------------------------------------------------
//
// Q3, the shape of the money: the tank is the truck's; diesel is paid for
// where it is bought. A run burns g_lane = roadMiles / AVG_MPG gallons. The
// tank covers what it has (fromTank, free -- that diesel was bought when it
// was pumped); the LEDGER buys the rest, and the price is
// fuelCostForGallons(g_lane - fromTank). With an empty tank that figure
// equals the old fuelCostFor(distanceMi) exactly -- pinned by test -- so no
// existing cash model changes, and a topped-up tank lowers the delivery-day
// charge by the diesel already paid for. Refuel is where new diesel costs
// money, not delivery.
//
// extraMiles (a resolved event's detour) are IN: they burn fuel, wear tires
// and land on the odometer. Not counting them would make the truck's mpg =
// distance/gallons wrong for every run that detoured. But their FUEL is
// charged by loadEvents resolve() as part of the option's costUsd -- so the
// ledger's fuel line here covers the lane only (g_lane - fromTank), and
// charging detour fuel again here would bill every detour twice.
//
// Road-event miles count, the LEDGER only sees the lane's unfueled share.
//
// Idempotency: runs INSIDE the caller's transaction, after markDelivered's
// conditional UPDATE claimed the load. Zero rows from that UPDATE means this
// function is never reached a second time for the same load.
export async function applyRunToTruck(client, load) {
  const truck = await trucksRepo.lockTruckForRun(client, load.truckId)
  if (!truck) return null

  const roadMiles = load.distanceMi + (load.extraMiles ?? 0)
  if (!(roadMiles > 0)) return null

  // The tank can only cover what it holds. fuel_gallons is an integer
  // column, so fromTank is rounded once, here, and the ledger pays for
  // everything the tank did not cover -- see splitTankAndPump for the
  // gallon that used to go missing between the two.
  const laneGallons = gallonsFor(roadMiles)
  const { fromTank, ledgerGallons } = splitTankAndPump(truck.fuelGallons, laneGallons)

  // Rear tires wear faster under load -- the two lives differ and the
  // numbers below are the sourced midpoints, see truckWear.js.
  const odoBefore = truck.odometerMi
  const odoAfter = Math.min(2000000, odoBefore + roadMiles)
  const frontTirePoints = tirePointsWorn(odoBefore, odoAfter, TIRE_LIFE_FRONT_MI)
  const rearTirePoints = tirePointsWorn(odoBefore, odoAfter, TIRE_LIFE_REAR_MI)

  const run = await trucksRepo.applyRunToTruck(client, {
    truckId: load.truckId,
    roadMiles,
    gallonsFromTank: fromTank,
    frontTirePoints,
    rearTirePoints,
    // Where the truck now is. Written here and nowhere else: the delivery
    // is the one moment the program knows the answer.
    endedAtLabel: deliveredTo(load)?.label ?? placeLabel(load.destinationCity, load.destinationState),
  })
  if (!run) return null


  // Daily telemetry: spread across sim days, capped, never losing a mile.
  // endSimDay is the sim day the run FINISHED (the day the driver arrived).
  // span is the broker's window so a 3,500-mi lane spreads over the days it
  // actually spanned; usedMilesByDay feeds the allocation so a second run
  // finishing on an already-booked sim day borrows earlier days rather than
  // breaking the 900-mi cap. The window read back is 370 sim days -- a
  // backlog deep enough that growth past it would mean a truck booked solid
  // for a simulated year, where reading further could not change the lesson.
  const spanDays = transitDaysFor({ pickupAt: load.pickupAt, deliveryAt: load.deliveryAt })
  const endSimDay = await simTodayIso(client)
  const usedByDay = await metricsRepo.usedMilesByDay(
    client, load.truckId, shiftIsoDate(endSimDay, -370), endSimDay,
  )
  const dayRows = allocateRunDays({
    roadMiles,
    endSimDay,
    spanSimDays: spanDays,
    usedByDay,
    capMi: DAILY_DISTANCE_CAP_MI,
  })
  const dayMiles = dayRows.map((r) => r.distanceMi)
  const gallons = splitGallons(dayMiles, laneGallons)
  // fuel_pct_end walks the TANK level, not the burn: the day rows record
  // where the gauge stood at each day's end, from the tank the run started
  // with.
  const tankStartGallons = truck.fuelGallons
  const fuelPctEnds = walkFuelPct(tankStartGallons, gallons, truck.fuelCapacityGal)
  await metricsRepo.addDailyMetrics(client, load.truckId,
    dayRows.map((r, i) => ({
      day: r.day,
      distanceMi: r.distanceMi,
      fuelGallons: gallons[i],
      fuelPctEnd: fuelPctEnds[i],
    })))

  // Did the odometer cross a service multiple? One 'due' row per (truck,
  // service, mileage), guarded by the unique index -- the tick retrying
  // cannot open it twice.
  const dueMileage = serviceDueMileage(odoBefore, odoAfter, OIL_SERVICE_INTERVAL_MI)
  if (dueMileage !== null) {
    await maintenanceRepo.openServiceDue(client, {
      truckId: load.truckId,
      service: OIL_SERVICE_LABEL,
      dueMileage,
      dueDate: await simTodayIso(client),
    })
  }

  // What the LEDGER owes: only the share the tank did not cover, priced at
  // the pump. Null (no truck, zero miles) falls back to the old formula at
  // the call site.
  return fuelCostForGallons(ledgerGallons)
}

// The sim clock, from the database. sim_today() (migration 032) is the
// compressed calendar's today -- a DATE that advances once per simulated
// day (thirty real minutes since 2026-11-08). Asked through the
// transaction's client so every read in one delivery
// sees the same clock.
async function simTodayIso(client) {
  const result = await client.query(SIM_TODAY_SQL)
  return result.rows[0].day
}

// 'YYYY-MM-DD' shifted by whole days, in UTC. Sim days are consecutive
// calendar dates by construction (sim_day advances REAL_SEC_PER_SIM_DAY seconds per step), so
// date arithmetic on the ISO string is sim-day arithmetic.
function shiftIsoDate(isoDay, days) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------
// Runs on a timer. Three jobs, each in its own transaction so one failing
// does not roll back the others: deliver what has arrived, pay what has
// come due, charge interest on the credit line.
//
// Every money event is guarded by a unique index (cash_ledger_once_per_ref
// in migration 019) as well as by the status column it reads, so running
// this twice at once cannot double-pay a load.

export async function deliverArrivedLoads() {
  const delivered = []
  // ONE TRANSACTION PER LOAD, not one per batch.
  //
  // The batch version deadlocked the whole simulator. Fuel went out
  // through cash.spend, which refuses a debit that would pass the credit
  // limit -- so a company at -$49,900 taking delivery of a 1,000-mile run
  // threw INSUFFICIENT_FUNDS, rolled back every load in the batch, and
  // took payDueInvoices() and chargeInterest() down with it, because
  // runTick awaits them in sequence. Invoices are the only income, so the
  // balance could never rise again, and the same batch failed identically
  // every thirty seconds forever.
  //
  // Two changes fix it: each load stands alone, and fuel is no longer
  // refusable. See below.
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    let handled = null
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const [load] = await loadsRepo.claimArrivedLoads(client, 1)
        if (!load) return

        const termDays = TERM_DAYS[load.paymentTerms] ?? 30
        const done = await loadsRepo.markDelivered(client, {
          loadId: load.id,
          dueSeconds: financeDaysToSeconds(termDays),
        })
        if (!done) return

        // The run happened to a TRUCK, not just to a ledger. Everything the
        // delivery writes -- odometer, tank, tires, daily rows, the service
        // flag -- lives in the same transaction as markDelivered, inside
        // the same conditional: if the tick ever retried this load, none of
        // this could run a second time, and if any part fails the delivery
        // rolls back with it and the next tick tries the whole thing again.
        // A console.error-swallowed truck update would strand the two
        // halves of one fact: a load delivered by a truck that never moved.
        // Returns the fuel the LEDGER owes (the burn the tank did not
        // cover); null when there is no truck to write to.
        const runFuelUsd = load.truckId ? await applyRunToTruck(client, load) : null

        // And the driver is where the truck is. Same transaction, same
        // place: a driver left in Seattle after a New York delivery is the
        // "two screens disagree" failure in its plainest form.
        const landed = deliveredTo(load)
        if (load.driverId && landed) await loadsRepo.moveDriverTo(client, { driverId: load.driverId, ...landed })

        // Fuel comes out on arrival, not on payment: the run cost money
        // weeks before the broker settles, and that gap is the squeeze
        // the whole cash side exists to teach.
        //
        // It goes through addEntry, NOT through cash.spend. A debit that
        // can be refused makes sense before a purchase -- you can decline
        // to buy a truck. It makes no sense afterwards: the diesel is
        // already burnt, the load is already delivered, and a simulator
        // that refuses to record a cost that has happened is lying about
        // the company's position. Going further into the credit line is
        // the correct outcome, and the interest is the consequence.
        //
        // What the burn IS, has changed (032): the tank pays for what it
        // can, the ledger pays for the rest. fuelCostForGallons(g_lane -
        // fromTank) comes out to exactly fuelCostFor(distanceMi) when the
        // tank is empty -- same total, pinned by test -- and less when the
        // tank covered part of the run, because that diesel was already
        // bought when it was pumped. Refuelling is where the new diesel is
        // paid for, not here.
        const fuel = runFuelUsd ?? fuelCostFor(load.distanceMi)
        if (fuel > 0) {
          await cashRepo.addEntry(client, {
            kind: 'fuel',
            amountUsd: -fuel,
            description: `Fuel — load ${load.id}, ${load.distanceMi} mi`,
            refType: 'load',
            refId: load.id,
          })
        }

        // The driver EARNS here. They are not paid here.
        //
        // This used to write straight into cash_ledger: the money left the
        // account at delivery, nobody chose to send it, and the dispatcher
        // never saw it happen. Which meant a driver could never be owed
        // anything, and a person who is never owed anything can never have
        // a grievance -- so the single hardest thing about running a small
        // carrier was quietly handled by the simulator on the student's
        // behalf.
        //
        // What is still true, and is the reason the squeeze exists: the
        // debt is incurred at DELIVERY, while the broker pays in thirty to
        // sixty days. Earning here and paying on a payroll run keeps that
        // gap and adds the decision that sits inside it.
        //
        // createSettlement is a no-op when this load already has one --
        // settlement_one_per_load, not a remembered check -- so the tick
        // retrying after a failure cannot pay a driver twice.
        const pay = settlementFor(load)
        let earned = null
        if (pay) {
          earned = await payrollRepo.createSettlement(client, {
            driverId: load.driverId,
            loadId: load.id,
            grossUsd: pay.gross,
            deductionsUsd: pay.deductions,
            netUsd: pay.net,
            dueSeconds: financeDaysToSeconds(SETTLEMENT_TERM_SIM_DAYS),
          })
        }

        // The post-trip inspection (49 CFR 396.11) rides the same
        // transaction: the report speaks about the truck AS IT ARRIVED --
        // the odometer and tread gauges applyRunToTruck just wrote -- so
        // the report and the truck state it describes are one fact. The
        // row shape comes from dvir.service.js's builder (pure seed), the
        // write from dvir.repository.js (the table's one writer).
        if (load.truckId) {
          const truckNow = await trucksRepo.getTruckById(load.truckId)
          if (truckNow) {
            const dvirRow = buildReportRow({
              rng: dvirRngFor(load.id),
              truck: { id: truckNow.id, odometerMi: truckNow.odometerMi, tireFrontPct: truckNow.tireFrontPct, tireRearPct: truckNow.tireRearPct },
              driverId: load.driverId,
              loadId: load.id,
              locationLabel: truckNow.currentLocation,
              hadBreakdown: false, // the run's open event was resolved before delivery; unresolved ones block claimArrivedLoads
            })
            await dvirRepo.insertReport(client, dvirRow)
          }
        }

        await loadsRepo.releaseDriver(client, { driverId: load.driverId })
        // owedUsd, not payUsd: nothing was paid. The tick's own log line
        // saying "paid $595" while the driver was still waiting would be
        // the first place a student learned to distrust it.
        handled = {
          id: load.id,
          fuelUsd: fuel,
          owedUsd: earned ? pay.net : 0,
          dueIn: termDays,
        }
      })
    } catch (err) {
      // One load that cannot be delivered must not stop the ones behind
      // it, and must not stop invoices being paid.
      console.error(`[tick] delivery failed: ${err.message}`)
      break
    }
    if (!handled) break
    delivered.push(handled)
  }
  return delivered
}

export async function payDueInvoices() {
  const paid = []
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    let handled = null
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const [load] = await loadsRepo.claimDueInvoices(client, 1)
        if (!load) return
        const marked = await loadsRepo.markInvoicePaid(client, load.id)
        if (!marked) return

        // The invoice is the rate PLUS whatever accessorials were billed
        // on it -- detention, layover, a second stop. Finance and the
        // dashboard have always counted those as revenue; paying only
        // rate_usd meant a $100 detention charge appeared on every report
        // and arrived in the account never.
        const amount = load.rateUsd + (load.accessorialsUsd ?? 0)
        await cash.receive(client, {
          kind: 'load_payment',
          amountUsd: amount,
          description: `${load.broker} — load ${load.id} (${load.paymentTerms})`,
          refType: 'load',
          refId: load.id,
        })
        handled = { id: load.id, amountUsd: amount }
      })
    } catch (err) {
      console.error(`[tick] invoice payment failed: ${err.message}`)
      break
    }
    if (!handled) break
    paid.push(handled)
  }
  return paid
}

// Fuel bought mid-route, paid for once the truck actually gets there.
//
// The STOP itself was already decided at dispatch (facilities/stopPlan.js)
// -- this only waits for arrived_at to pass and then pays for it, the same
// division of labour dispatch/tick already has for everything else: what
// happens is decided once, what it COSTS is charged when the clock says it
// happened. One transaction per visit, same reasoning as deliverArrivedLoads'
// own header -- one refused spend must not take payDueInvoices or the rest
// of the tick down with it.
export async function settleArrivedStops() {
  const settled = []
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    let handled = null
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const [visit] = await stopVisitsRepo.claimArrivedFuelVisits(client, 1)
        if (!visit) return

        // Unlike the delivery-day fuel charge (addEntry, never refused --
        // see applyRunToTruck's own comment on why a cost already incurred
        // cannot be declined), a mid-route top-up still goes through the
        // ordinary credit-limit guard: nothing forces this particular spend
        // the way a delivered load's burn is forced, so a company already
        // past its line meets the same refusal here it would meet buying
        // fuel any other way. A refusal leaves settled_at NULL -- the next
        // tick tries again.
        await cash.spend(client, {
          kind: 'fuel',
          amountUsd: visit.costUsd,
          description: `Fuel — stop at ${visit.facilityId}, load ${visit.loadId}`,
          refType: 'stop_visit',
          refId: String(visit.id),
        })

        const marked = await stopVisitsRepo.markSettled(client, visit.id)
        if (!marked) return

        // The tank fills by exactly what was bought here. lockTruckForRun
        // reads the level under lock so the top-up can't race a concurrent
        // delivery's burn; refuelTruck is reused as-is (the same function
        // fleet.service.js's own manual refuel() calls) rather than a
        // second UPDATE against trucks.
        const truck = await trucksRepo.lockTruckForRun(client, visit.truckId)
        if (truck) {
          const toGallons = Math.min(truck.fuelCapacityGal, truck.fuelGallons + visit.gallons)
          await trucksRepo.refuelTruck(client, { truckId: visit.truckId, toGallons })
        }

        handled = { id: visit.id, loadId: visit.loadId, costUsd: visit.costUsd, gallons: visit.gallons }
      })
    } catch (err) {
      console.error(`[tick] stop settlement failed: ${err.message}`)
      break
    }
    if (!handled) break
    settled.push(handled)
  }
  return settled
}

// Interest accrues every tick against the balance as it stands, and the
// clock advances whether or not anything is owed.
//
// The previous version read its watermark out of the ledger, and no
// interest row is written while the balance is healthy -- so the
// watermark stood still for as long as the company was solvent and the
// first dip into the credit line was billed for every simulated day since
// the last charge. Measured: an hour of profitable play then a dip to
// -$10,000 produced $148 against a true $5. Overnight it was $3,551.
//
// Fractions are carried in sim_state rather than rounded away each tick.
// Thirty seconds at -$10,000 is $1.23; rounding that up every tick would
// bill about 20% more than the rate says.
//
// `enabled` and `run` are seams, not options any caller sets: the tick
// calls this with no arguments. They exist so a test can prove that
// FINANCE=off opens no transaction at all, on a machine with or without a
// database behind it.
export async function chargeInterest({ enabled = config.financeEnabled, run = withTransaction } = {}) {
  // FINANCE=off. Nothing accrues, and the watermark is deliberately NOT
  // advanced: switching finance back on bills from where it left off
  // rather than pretending the period was paid. See config.js.
  if (!enabled) return null
  let charged = null
  await run(async (client) => {
    const state = await cashRepo.readInterestState(client)
    if (!state) return

    const now = new Date()
    // Capped. Interest used to be billed from wall-clock elapsed time
    // while every other part of the simulator is event-driven and just
    // catches up once -- so a laptop closed for eight hours came back to
    // 240 simulated days of interest on a company that had hauled nothing
    // and collected nothing meanwhile. See MAX_CATCHUP_REAL_MS.
    const elapsedSimDays = billableSimDays(now.getTime() - state.lastAt.getTime())
    if (elapsedSimDays <= 0) return

    const balance = await cashRepo.getBalance(client)
    // interestForPeriod returns 0 for a balance at or above zero, so a
    // solvent company accrues nothing -- but the clock still moves.
    // Tiered. The first $50,000 is the committed line at the contract
    // rate; anything past it is an unauthorised overdraft and carries the
    // default margin. Charging one rate on a facility that had been
    // exhausted three times over was the shape of a bug, not a deal.
    const accrued = state.accruedUsd + interestForPeriodExactTiered(balance, elapsedSimDays)
    const whole = Math.floor(accrued)

    if (whole >= 1) {
      await cashRepo.addEntry(client, {
        kind: 'interest',
        amountUsd: -whole,
        description: `Credit line interest at $${Math.abs(balance).toLocaleString()}`,
      })
      charged = { amountUsd: whole, balance }
    }

    await cashRepo.writeInterestState(client, {
      lastAt: now,
      accruedUsd: Number((accrued - whole).toFixed(6)),
    })
  })
  return charged
}

// Insurance, on the compressed calendar.
//
// MONTHLY_INSURANCE has been sitting in finance.constants.js since the
// cost model was written and nothing ever charged it, so the only
// recurring expense in the simulator was interest -- and a company with
// no debt had no fixed costs at all, which is the opposite of running
// trucks. It is charged per truck: insurance scales with the fleet, and a
// fleet manager who buys a fourth tractor should see the premium move.
//
// Billed in whole simulated days rather than monthly, for the same reason
// interest is: a monthly cycle is sixty real minutes and a student would
// meet it once. Daily, it is visible without being loud.
// Same two seams as chargeInterest, for the same reason.
export async function chargeInsurance({ enabled = config.financeEnabled, run = withTransaction } = {}) {
  // FINANCE=off: the premium does not accrue and the watermark stands.
  if (!enabled) return null
  let charged = null
  await run(async (client) => {
    const state = await cashRepo.readInsuranceState(client)
    if (!state) return

    const now = new Date()
    // Capped for the same reason as interest: the fleet is not insured
    // through a night the simulator spent switched off.
    const elapsedSimDays = billableSimDays(now.getTime() - state.lastAt.getTime())
    if (elapsedSimDays <= 0) return

    const trucks = await cashRepo.countInsurableTrucks(client)
    const perDay = (MONTHLY_INSURANCE / 30) * trucks
    const accrued = state.accruedUsd + perDay * elapsedSimDays
    const whole = Math.floor(accrued)

    if (whole >= 1) {
      await cashRepo.addEntry(client, {
        kind: 'insurance',
        amountUsd: -whole,
        description: `Fleet insurance — ${trucks} truck${trucks === 1 ? '' : 's'}`,
      })
      // The balance AFTER this charge, so the log can state where the
      // account actually stands rather than where it stood a moment ago.
      charged = { amountUsd: whole, trucks, balance: await cashRepo.getBalance(client) }
    }

    await cashRepo.writeInsuranceState(client, {
      lastAt: now,
      accruedUsd: Number((accrued - whole).toFixed(6)),
    })
  })
  return charged
}

// Undo a dispatch.
//
// A load sent to the wrong driver had no way back: 'ontime' led only to
// the tick, and the tick only leads to 'done'. The driver is released in
// the same transaction, or a cancel would leave them marked as running
// freight that is no longer theirs.
export async function cancelDispatch({ loadId }) {
  return withTransaction((client) => undoDispatch(client, loadId))
}

// A load that will not make its window, and one that already has not.
//
// 'warn' means the current ETA is past what was promised -- still moving,
// going to be late. 'crit' means the promised delivery time has come and
// gone and the freight is not there. Neither is a verdict on the
// dispatcher: they are facts about where the truck is, which is exactly
// what a dispatcher is paid to notice early.
export async function markLateLoads() {
  const marked = []
  await withTransaction(async (client) => {
    const rows = await loadsRepo.markLate(client)
    marked.push(...rows)
  })
  return marked
}

// drivers.hos_remaining_min / hours_today_min / hours_week_min /
// duty_status, derived from duty_events (037) for every working driver --
// the writer those columns never had (hos.js's header). One transaction
// for the whole roster: a company has a handful of drivers, and a
// half-synced roster would show two drivers on two different clocks.
export async function syncDriverHos() {
  const nowMs = Date.now()
  const since = new Date(nowMs - simDaysToMs(HOS_LOOKBACK_HOURS / 24))
  const synced = []
  await withTransaction(async (client) => {
    const rows = await dutyEventsRepo.recentForWorkingDrivers(client, { since })
    for (const { driverId, events } of rows) {
      const snap = driverHosSnapshot(events, nowMs)
      // eslint-disable-next-line no-await-in-loop -- one small UPDATE per driver
      const done = await dutyEventsRepo.updateDriverHos(client, {
        driverId,
        dutyStatus: snap.dutyStatus,
        hosRemainingMin: snap.hosRemainingMin,
        hoursTodayMin: snap.hoursTodayMin,
        hoursWeekMin: snap.hoursWeekMin,
      })
      if (done) synced.push(driverId)
    }
  })
  return synced
}

// Stop the payroll clock while the company was not running.
//
// Interest drops an offline gap (billableSimDays); a settlement's due date
// is a wall-clock instant, so it kept ageing through the same gap and the
// driver came back "4,236 days past due" and sat in the quits stage for
// good. This shifts every unpaid due_at forward by what the gap dropped
// (gap minus MAX_CATCHUP_REAL_MS), once: the watermark row is locked FOR
// UPDATE, so concurrent ticks queue, and each one moves it forward in the
// same transaction as the shift. A normal gap shifts nothing. Payroll
// itself stays manual.
//
// Broker invoices are deliberately NOT shifted: an invoice that comes due
// while the server is off is simply paid on the next tick -- the company
// is paid early, nothing ages into a penalty.
export async function holdPayrollClock({ run = withTransaction, nowFn = () => new Date() } = {}) {
  let held = 0
  await run(async (client) => {
    const now = nowFn()
    const lastAt = await payrollRepo.lockTickClock(client, now)
    if (!lastAt) return
    const seconds = droppedGapSeconds(now.getTime() - lastAt.getTime())
    if (seconds > 0) held = await payrollRepo.holdSettlementClock(client, seconds)
    // Never backwards: a tick that queued on the lock carries a `now`
    // taken before the previous one wrote its own.
    if (now > lastAt) await payrollRepo.writeTickClock(client, now)
  })
  return held
}

// The three stages are independent on purpose. Each one already handles
// its own failures, and this makes sure a thrown error in one can never
// stop the other two -- the failure mode that froze the whole simulator.
export async function runTick() {
  const settle = async (label, fn) => {
    try {
      return await fn()
    } catch (err) {
      console.error(`[tick] ${label} failed: ${err.message}`)
      return null
    }
  }
  // First: a settlement earned by this tick's deliveries must not be
  // shifted by a gap that ended before it existed.
  await settle('payroll clock', holdPayrollClock)
  const delivered = (await settle('delivery', deliverArrivedLoads)) ?? []
  const paid = (await settle('invoices', payDueInvoices)) ?? []
  // Mid-route fuel: the stop was already decided at dispatch, this is only
  // the money once arrived_at has passed. Same place in the sequence as
  // `paid` -- both settle something the world already did.
  const stopsSettled = (await settle('stops', settleArrivedStops)) ?? []
  const interest = await settle('interest', chargeInterest)
  const insurance = await settle('insurance', chargeInsurance)
  // Weekly rent on leased trucks that have a driver (operational sim clock).
  const lease = await settle('lease', chargeTruckLeases)
  // Events are rolled AFTER delivery, not before. A load that has already
  // arrived should not meet a blizzard on the tick that delivers it, and
  // deliverArrivedLoads skips loads with an open event anyway -- rolling
  // first would strand a truck that was standing in the receiver's yard.
  const events = (await settle('events', () => rollEvents())) ?? []
  // Last, so a load whose ETA just moved is classified on this tick
  // rather than looking on time for another thirty seconds.
  const late = (await settle('lateness', markLateLoads)) ?? []
  // After delivery (releaseDriver) so a driver who just finished is read
  // off their log, not left on whatever the release wrote.
  const hosSynced = (await settle('hos', syncDriverHos)) ?? []
  return { delivered, paid, stopsSettled, interest, insurance, lease, events, late, hosSynced }
}

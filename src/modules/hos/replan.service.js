// A road event, written into the driver's log, and the rest of the run
// planned again under the law.
//
// Until now a resolved event only pushed eta_at back by the option's
// hours (loadEvents.sql.js's EXTEND_ETA_SQL). The driver's log (037) kept
// the dispatch-time plan as if nothing had happened: the HOS clocks never
// saw the nine hours on the shoulder, a reroute's three extra hours of
// driving never counted toward the 11, and no violation could ever
// appear. This closes that gap:
//
//   1. The plan from the event's own moment (load_events.occurred_at) on
//      is cut -- it did not happen; the truck stopped there.
//   2. The delay is written as what the law calls it
//      (constants/loadEvents.js's dutyStatusDuring: attending a disabled
//      truck and waiting at a dock are On Duty; sitting out weather is
//      Off Duty; a detour is Driving).
//   3. The rest of the route is planned again from where the truck was
//      (stopPlan.js's drivenMilesBefore/sliceRouteFrom), with the
//      driver's whole log -- delay included -- as prior history. So a
//      reroute that pushed the driver past 11 hours starts the remainder
//      with the 10-hour rest it now needs, and eta_at becomes that legal
//      arrival instead of "old ETA + the option's hours".
//
// Runs AFTER resolve's own transaction commits, same reasoning as
// dispatch.service.js's planAndSaveStops: nothing here can undo the
// dispatcher's decision or its charge. What it concluded -- or why it
// could not -- is appended to the load's stop_plan_facts, never only
// logged.
//
// Known limit, stated: while an event is still OPEN (not yet decided),
// the log keeps showing the old plan. The cut happens at resolve, back to
// occurred_at.

import { withTransaction, pool } from '../../db/pool.js'
import * as loadsRepo from '../loads/loads.repository.js'
import * as dutyEventsRepo from './dutyEvents.repository.js'
import * as stopVisitsRepo from '../facilities/stopVisits.repository.js'
import * as routingRepo from '../routing/routing.repository.js'
import * as trucksRepo from '../fleet/trucks.repository.js'
import * as facilitiesService from '../facilities/facilities.service.js'
import {
  planStops, describeWarning, drivenMilesBefore, sliceRouteFrom,
} from '../facilities/stopPlan.js'
import { fromHosDomain, HOS_LOOKBACK_HOURS } from '../../constants/hosClock.js'
import { simDaysToMs } from '../../constants/simClock.js'
import { AVG_MPG } from '../finance/finance.constants.js'

function fact(code, detail, cfr = null) {
  return { code, cfr, detail }
}

export async function replanAfterEvent({ loadId, eventAt, delayHours, delayStatus, label }) {
  const facts = []
  const say = () => loadsRepo.appendStopPlanFacts(pool, { loadId, facts })

  const load = await loadsRepo.getLoadById(loadId)
  if (!load || load.deliveredAt || !load.dispatchedAt || !load.driverId) {
    // Nothing running to re-plan (delivered or cancelled in between).
    return { replanned: false, legalArrivalAt: null }
  }
  if (!delayStatus) {
    facts.push(fact('EVENT_NOT_LOGGED', `${label}: no duty status is defined for this option, so the delay is not on the driver's log.`))
    await say()
    return { replanned: false, legalArrivalAt: null }
  }

  const eventMs = new Date(eventAt).getTime()
  const delayEndMs = eventMs + simDaysToMs(delayHours / 24)
  const runEvents = await dutyEventsRepo.forLoad(pool, loadId)
  const drivenMi = Math.min(load.distanceMi, Math.max(0, drivenMilesBefore(runEvents, eventMs)))
  const remainingMi = load.distanceMi - drivenMi
  const fuelStopsBefore = await stopVisitsRepo.fuelStopsBefore(pool, { loadId, at: new Date(eventMs) })

  // 1 + 2: cut the plan at the event, write the delay.
  await withTransaction(async (client) => {
    await dutyEventsRepo.cutLoadAt(client, { loadId, at: new Date(eventMs) })
    await stopVisitsRepo.deleteUnsettledFrom(client, { loadId, at: new Date(eventMs) })
    await dutyEventsRepo.insertMany(client, [{
      driverId: load.driverId,
      loadId,
      truckId: load.truckId,
      status: delayStatus,
      startedAt: new Date(eventMs),
      endedAt: new Date(delayEndMs),
      routeOffsetMi: Math.round(drivenMi),
      facilityId: null,
    }])
  })
  facts.push(fact('ROAD_EVENT_LOGGED', `${label}: ${delayHours}h logged as ${delayStatus} at mile ${Math.round(drivenMi)} of the run.`))

  // 3: the rest of the run, planned again.
  const lane = {
    origin: { city: load.originCity, state: load.originState },
    destination: { city: load.destinationCity, state: load.destinationState },
  }
  const routes = await routingRepo.getRoutes(lane)
  const primary = routes.find((r) => r.alternativeIndex === 0)
  const truck = load.truckId ? await trucksRepo.getTruckById(load.truckId) : null
  if (!primary || !truck || !(remainingMi > 0.5)) {
    if (remainingMi > 0.5) {
      facts.push(fact('REPLAN_SKIPPED', 'The rest of the run could not be planned again (no cached route or truck); the ETA moved by the option\'s hours only.'))
    }
    await say()
    return { replanned: false, legalArrivalAt: null }
  }

  // The tank at the event, by the plan's own arithmetic: full if a
  // planned fuel stop came before it, otherwise the dispatch-time tank
  // less what the miles so far burned.
  const tankAtEvent = fuelStopsBefore > 0
    ? truck.fuelCapacityGal
    : Math.max(0, truck.fuelGallons - drivenMi / AVG_MPG)

  const prior = await dutyEventsRepo.recentForDriver(pool, {
    driverId: load.driverId,
    since: new Date(delayEndMs - simDaysToMs(HOS_LOOKBACK_HOURS / 24)),
  })
  const facilities = await facilitiesService.listAll()
  const plan = planStops({
    routeGeometry: sliceRouteFrom(primary.geometry, drivenMi / load.distanceMi),
    distanceMi: remainingMi,
    startFuelGallons: tankAtEvent,
    fuelCapacityGal: truck.fuelCapacityGal,
    facilities,
    dispatchedAt: new Date(delayEndMs).toISOString(),
    promisedEtaAt: load.promisedEtaAt,
    priorDutyEvents: prior,
  })
  facts.push(...plan.hosFacts)
  facts.push(...plan.warnings.map((w) => fact(w.code, describeWarning(w))))

  if (!plan.legalArrivalAt) {
    facts.push(fact('REPLAN_NO_ARRIVAL', 'The re-plan produced no arrival time; the ETA moved by the option\'s hours only.'))
    await say()
    return { replanned: false, legalArrivalAt: null }
  }

  const offset = Math.round(drivenMi)
  const rows = fromHosDomain(plan.dutyTimeline, delayEndMs).map((e) => ({
    driverId: load.driverId,
    loadId,
    truckId: load.truckId,
    status: e.status,
    startedAt: new Date(e.startedAt),
    endedAt: new Date(e.endedAt),
    routeOffsetMi: e.routeOffsetMi == null ? null : e.routeOffsetMi + offset,
    facilityId: e.facilityId,
  }))
  await withTransaction(async (client) => {
    await dutyEventsRepo.insertMany(client, rows)
    if (plan.stops.length > 0) {
      await stopVisitsRepo.insertMany(client, plan.stops.map((s) => ({
        loadId,
        truckId: load.truckId,
        driverId: load.driverId,
        facilityId: s.facilityId,
        reason: s.reason,
        routeOffsetMi: s.routeOffsetMi + offset,
        arrivedAt: s.arrivedAt,
        departedAt: s.departedAt,
        gallons: s.gallons,
        costUsd: s.costUsd,
      })))
    }
  })

  const updated = await loadsRepo.setLegalEtaAt(pool, { loadId, legalArrivalAt: plan.legalArrivalAt })
  facts.push(fact('ETA_REPLANNED', `After ${label.toLowerCase()}, the HOS-legal arrival is ${plan.legalArrivalAt}.`))
  await say()
  return { replanned: Boolean(updated), legalArrivalAt: updated ? plan.legalArrivalAt : null }
}

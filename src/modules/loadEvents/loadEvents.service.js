// Raising events, and applying what the dispatcher decided.

import { withTransaction } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import * as repo from './loadEvents.repository.js'
import * as cashRepo from '../cash/cash.repository.js'
import * as chatRepo from '../driverChat/driverChat.repository.js'
// How long before the driver's own report lands. Seconds, not minutes: on
// the compressed calendar a two-day run is four real minutes, so anything
// longer would put the call after the delivery. Long enough to read as a
// person pulling over, short enough to be the first thing the dispatcher
// hears.
const EVENT_REPORT_DELAY_SEC = 12
import {
  EVENT_TYPES, chanceForFraction, pickEventType, resolveOption, optionsFor, dutyStatusDuring,
} from '../../constants/loadEvents.js'
import { replanAfterEvent } from '../hos/replan.service.js'
import * as loadsRepo from '../loads/loads.repository.js'
import { pool } from '../../db/pool.js'
import { simDaysToSeconds } from '../../constants/simClock.js'

// Where the driver is when they call.
//
// Derived from the load's own lane and how far along it is, because
// drivers.current_location has no runtime writer -- a position read from
// that column would be whatever the seed said, unchanged, forever. Before
// halfway they are still near where they loaded; after, near where they
// are going. Rough, and true.
export function placeFor(load, elapsedFraction) {
  const nearOrigin = !(elapsedFraction >= 0.5)
  return nearOrigin
    ? `${load.originCity}, ${load.originState}`
    : `${load.destinationCity}, ${load.destinationState}`
}

// Roll for every load in transit. Called by the tick.
//
// One transaction per load, like every other stage: a load whose event
// cannot be raised must not stop the ones behind it.
export async function rollEvents({ rng = Math.random, limit = 50 } = {}) {
  const candidates = await repo.inTransitLoads(null, limit)
  const raised = []

  // Every load the tick looked at is marked checked, whether or not it met
  // anything. Marking only the ones that did would leave a quiet load's
  // elapsed fraction growing until it met something with certainty.
  await repo.markChecked(null, candidates.map((l) => l.id))
    .catch((e) => console.error('[loadEvents] could not mark checked:', e.message))

  for (const load of candidates) {
    const transitSeconds = Number(load.transitSeconds) || 0
    if (transitSeconds <= 0) continue

    // The share of the run that has passed since this load was last
    // rolled. Cadence-independent on purpose: the tick fires every 30
    // seconds locally and every 60 on Vercel, and a tick-count derivation
    // silently halved the event rate in production.
    const fraction = Number(load.sinceCheckFraction)
    if (!(fraction > 0)) continue
    if (rng() >= chanceForFraction(fraction)) continue

    // A truck sent out past its service interval does not roll the dice on
    // WHAT it meets -- only on WHEN. The chance above is unchanged (Q5 in
    // the plan: no new probability, a changed outcome); the overdue truck's
    // event is always a breakdown, the one failure mode an unserviced truck
    // actually produces. No blocking, no disabled dispatch: the consequence
    // is the shoulder.
    const eventType = load.serviceOverdue ? 'breakdown' : pickEventType(rng)
    const place = placeFor(load, Number(load.elapsedFraction))

    try {
      // eslint-disable-next-line no-await-in-loop
      const event = await withTransaction(async (client) => {
        const row = await repo.raiseEvent(client, { loadId: load.id, eventType, place })
        // null means this load already had an open event between the
        // SELECT and here. Not an error.
        return row
      })
      if (!event) continue

      // The driver reports it. Fire and forget: a chat write that fails
      // must not un-raise an event that has already happened.
      if (load.driverId) {
        // eslint-disable-next-line no-await-in-loop
        await reportToDriver({ driverId: load.driverId, eventType, place })
          .catch((e) => console.error('[loadEvents] could not report to chat:', e.message))
      }
      raised.push({ ...event, driverId: load.driverId })
    } catch (err) {
      console.error(`[loadEvents] could not raise on ${load.id}: ${err.message}`)
    }
  }

  return raised
}

// The driver's own words, composed from the event rather than generated.
// Same rule as the refusal line: this has to agree with load_events
// exactly, and a model sentence can drift from it.
async function reportToDriver({ driverId, eventType, place }) {
  const type = EVENT_TYPES[eventType]
  if (!type) return null
  const content = type.report({ place })

  // Into threads that already exist, and none if nobody has ever messaged
  // this driver. The tick has no user, and nothing about a blizzard
  // belongs to one dispatcher; creating a conversation for every account
  // on the system would manufacture threads nobody started. The event
  // still reaches the load page and the alert board either way.
  const conversations = await chatRepo.conversationsForDriver(driverId)
  if (conversations.length === 0) return null

  // NOT driverReplyDelaySec. That is calibrated for the marketplace clock
  // -- 120 to 300 real seconds for a driver who is driving -- and a whole
  // two-day run is 240 real seconds. The report would have landed one to
  // two SIMULATED days after the truck stopped, often after the load had
  // already gone late, and the thread would read as though the driver had
  // mentioned the breakdown days after the board knew about it.
  //
  // A driver calls in a breakdown immediately. They pull over first.
  const delaySec = EVENT_REPORT_DELAY_SEC

  // kind 'report': this happened. A chat reply arriving later must not
  // overwrite it, which is exactly what replacePendingReply used to do --
  // a dispatcher who typed anything while a blizzard report was pending
  // destroyed it, and nothing looked broken because the event was still on
  // the load page. See migration 028.
  return Promise.all(conversations.map((c) =>
    chatRepo.addMessage(c.id, 'driver', content, { delaySec, kind: 'report' })))
}

// What the dispatcher is choosing between.
export async function getOpenEvent(loadId) {
  const event = await repo.openEvent(loadId)
  if (!event) return null
  return {
    ...event,
    summary: EVENT_TYPES[event.eventType]?.summary ?? event.eventType,
    options: optionsFor(event.eventType),
  }
}

export async function listForLoad(loadId) {
  const rows = await repo.listForLoad(loadId)
  return rows.map((r) => ({
    ...r,
    summary: EVENT_TYPES[r.eventType]?.summary ?? r.eventType,
  }))
}

// Apply a choice.
//
// One transaction: the ETA move, the money and the resolution have to land
// together or a student pays for a tow that did not happen.
export async function resolve({ eventId, loadId, optionKey, userId }) {
  const result = await resolveInner({ eventId, loadId, optionKey, userId })

  // The delay onto the driver's log, and the rest of the run planned again
  // under HOS (hos/replan.service.js). AFTER the transaction above: the
  // decision and its charge stand whatever happens here. A failure is
  // written onto the load's stop_plan_facts, not only logged.
  const e = result.event
  const replan = await replanAfterEvent({
    loadId: result.loadId,
    eventAt: result.occurredAt,
    delayHours: result.applied.hours,
    delayStatus: dutyStatusDuring(result.eventType, result.applied.key),
    label: `${EVENT_TYPES[result.eventType]?.summary ?? 'Road event'} (${result.applied.label})`,
  }).catch(async (err) => {
    await loadsRepo.appendStopPlanFacts(pool, {
      loadId: result.loadId,
      facts: [{ code: 'REPLAN_FAILED', cfr: null, detail: `The road event could not be written to the driver's log (${err.message}); the ETA moved by the option's hours only.` }],
    }).catch((writeErr) => {
      console.error(`[loadEvents] event ${e?.id}: replan failed (${err.message}) and so did recording that (${writeErr.message})`)
    })
    return { replanned: false, legalArrivalAt: null }
  })

  const etaAt = replan.legalArrivalAt ?? result.etaAt
  return {
    event: result.event,
    applied: result.applied,
    etaAt,
    promisedEtaAt: result.promisedEtaAt,
    nowLate: Boolean(etaAt && result.promisedEtaAt && new Date(etaAt) > new Date(result.promisedEtaAt)),
    hosReplanned: replan.replanned,
  }
}

async function resolveInner({ eventId, loadId, optionKey, userId }) {
  return withTransaction(async (client) => {
    const event = await repo.claimEvent(client, eventId)
    if (!event) throw new AppError('EVENT_NOT_FOUND')

    // The event has to belong to the load in the URL. Without this the id
    // in the path was decoration: POST /loads/9999/events/88/resolve
    // resolved event 88 and charged whatever load it actually belonged to.
    if (loadId && event.loadId !== loadId) throw new AppError('EVENT_NOT_FOUND')

    const applied = resolveOption(event.eventType, optionKey)
    if (!applied) throw new AppError('EVENT_OPTION_INVALID')

    // The conditional UPDATE is the second half of "cannot resolve twice";
    // FOR UPDATE in claimEvent is the first.
    const resolved = await repo.resolveEvent(client, eventId, applied)
    if (!resolved) throw new AppError('EVENT_NOT_FOUND')

    // Hours are SIMULATED hours -- the same calendar eta_at lives on.
    const seconds = simDaysToSeconds(applied.hours / 24)
    const load = await repo.extendEta(client, event.loadId, seconds)

    if (applied.costUsd > 0) {
      // addEntry, not spend: this is a cost already incurred by the
      // choice, and the account is allowed to go negative. Refusing it
      // would be blocking, and this project's rule is consequence.
      await cashRepo.addEntry(client, {
        // 'road_event', not 'fuel'. A tow booked as fuel would put $1,450
        // into the fuel line of every expense report and quietly make
        // cost-per-mile wrong.
        kind: 'road_event',
        amountUsd: -applied.costUsd,
        description: `${applied.label} — load ${event.loadId} (${event.place})`,
        refType: 'load_event',
        refId: String(eventId),
        userId: userId ?? null,
      })
    }

    // extra_miles is recorded and charged as fuel, but NOT added to
    // loads.distance_mi. distance_mi is the contracted lane -- what the
    // broker pays for and what the rate per mile is measured against.
    // Adding detour miles to it would quietly raise a per-mile driver's
    // settlement for a detour the dispatcher chose, and move every
    // cost-per-mile figure on the load. The miles are the carrier's cost;
    // the lane is what was sold. Written down because the alternative
    // reads like an oversight.
    if (applied.accessorialUsd > 0) {
      await repo.addAccessorial(client, event.loadId, applied.accessorialLabel, applied.accessorialUsd)
    }

    return {
      event: resolved,
      applied,
      loadId: event.loadId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      etaAt: load?.etaAt ?? null,
      promisedEtaAt: load?.promisedEtaAt ?? null,
    }
  })
}

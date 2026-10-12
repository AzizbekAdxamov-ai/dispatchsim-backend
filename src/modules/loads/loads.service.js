// Business logic for the loads read endpoints. Combines loads.repository.js
// with the shared progress/timeline math (lib/loadTimeline.js) — no SQL
// lives here, only shaping.

import * as loadsRepo from './loads.repository.js'
import * as loadEventsRepo from '../loadEvents/loadEvents.repository.js'
import { pool } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import { computeProgress, computeTimeline } from '../../lib/loadTimeline.js'
import { liveTrackingFor } from '../tracking/tracking.service.js'

export async function listLoads({ status, equipmentType, search, page, limit }) {
  const offset = (page - 1) * limit

  const [loads, counts] = await Promise.all([
    loadsRepo.listLoads({ status, equipmentType, search, limit, offset }),
    loadsRepo.countLoadStatuses({ equipmentType, search }),
  ])

  return { loads, meta: { total: counts.all, page, limit, counts } }
}

export async function getLoadById(id) {
  const load = await loadsRepo.getLoadById(id)
  if (!load) {
    throw new AppError('LOAD_NOT_FOUND')
  }

  // On the road: the map's position (liveTracking.js), and the percentage
  // is that position's -- not the share of pickup..delivery that has
  // passed, which read 100% for a truck still at the shipper (600010,
  // 2026-10-08). Off the road: the old reading, which is 0 or 100 there.
  const tracking = await liveTrackingFor(load)
  return {
    ...load,
    progress: tracking ? Math.round(tracking.fraction * 100) : computeProgress(load),
    tracking,
    timeline: computeTimeline(load),
  }
}

// ---------------------------------------------------------------------
// GET /loads/board -- the dispatch board, four columns
// ---------------------------------------------------------------------
//
// One query per column, not one clever UNION: the columns answer
// different questions, they fail independently, and a board that goes
// blank because the delivered query broke reads as "nothing is moving"
// -- the exact reading a blank screen gives. Each row carries what the
// card shows: the lane, the rate, the driver/truck, and -- for the
// moving ones -- the open road event and the promised-window reading.
// Labels are the frontend's job (hardcoded UI matni yoʻq); this returns
// keys and facts.

// Shared card shape from a ROW_SELECT row -- the same projection the
// loads list uses, so the board can never show a load differently from
// the way the list shows it.
function cardFrom(row) {
  return {
    id: row.id,
    driverId: row.driverId,
    truckId: row.truckId,
    broker: row.broker,
    originCity: row.originCity,
    originState: row.originState,
    destinationCity: row.destinationCity,
    destinationState: row.destinationState,
    distanceMi: row.distanceMi,
    rateUsd: row.rateUsd,
    equipmentType: row.equipmentType,
    status: row.status,
    driver: row.driver,
    truck: row.truck,
    pickupAt: row.pickupAt,
    deliveryAt: row.deliveryAt,
    dispatchedAt: row.dispatchedAt,
    etaAt: row.etaAt,
    promisedEtaAt: row.promisedEtaAt,
    progress: computeProgress(row),
  }
}

// 'Assigned' is the window between the dispatch (a row was written) and
// the run's first driving minute. On the compressed calendar that gap is
// real: the stop planner opens the run with the driver's OWED REST at the
// origin (stopPlan.js), so a driver who just delivered spends that rest
// in the Assigned column before the log's first driving block starts.
// The read is the ELD's own -- the same duty_events the log screens show
// -- so a load is Assigned exactly while its log has no driving minute
// yet, and In Transit from the moment it does.
export async function getBoard({ limit = 40 } = {}) {
  // limit is a bound parameter ($1), never spliced -- and it is always
  // bound: LIMIT $1 with no parameter is PostgreSQL's 'there is no
  // parameter $1', which is how this query first shipped.
  const buildQuery = (condition) => [
    `
    SELECT ${loadsRepo.LOAD_COLUMNS}, driver_row.driver AS driver, truck_row.truck AS truck
      FROM loads l
      ${loadsRepo.DRIVER_TRUCK_LATERAL}
     ${condition}
     ORDER BY l.rate_usd DESC
     LIMIT $1`,
    [limit],
  ]

  const [availableRes, assignedRes, inTransitRes, deliveredRes, openEvents] = await Promise.all([
    pool.query(...buildQuery(`WHERE l.status = 'neutral'`)),
    pool.query(...buildQuery(
      `WHERE l.status IN ('ontime', 'warn', 'crit')
         AND l.dispatched_at IS NOT NULL AND l.delivered_at IS NULL
         AND l.driver_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM duty_events e
            WHERE e.load_id = l.id AND e.driver_id = l.driver_id
              AND e.status = 'driving' AND e.record_status = 'active'
              AND e.started_at <= now())`)),
    pool.query(...buildQuery(
      `WHERE l.status IN ('ontime', 'warn', 'crit')
         AND l.dispatched_at IS NOT NULL AND l.delivered_at IS NULL
         AND l.driver_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM duty_events e
            WHERE e.load_id = l.id AND e.driver_id = l.driver_id
              AND e.status = 'driving' AND e.record_status = 'active'
              AND e.started_at <= now())`)),
    pool.query(...buildQuery(`WHERE l.status = 'done'`)),
    loadEventsRepo.openEvents(),
  ])

  // The open event, keyed for the board: a moving load with an unresolved
  // event is stopped -- the same fact the alerts board raises -- and the
  // card says so in place rather than sending the student hunting.
  const eventByLoad = new Map(openEvents.map((e) => [e.loadId, e]))

  const shape = (r) => {
    const card = cardFrom(r)
    const event = eventByLoad.get(r.id)
    return {
      ...card,
      stopped: Boolean(event),
      openEvent: event ? { eventType: event.eventType, place: event.place, occurredAt: event.occurredAt } : null,
    }
  }

  return {
    available: availableRes.rows.map(shape),
    assigned: assignedRes.rows.map(shape),
    inTransit: inTransitRes.rows.map(shape),
    delivered: deliveredRes.rows.map(shape),
  }
}

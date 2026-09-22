// HTTP layer for /tracking. No business logic -- see tracking.service.js.
// The route already sits behind requireAuth + requireRole().

import * as trackingService from './tracking.service.js'
import { routeQuerySchema, loadRouteParamsSchema } from './tracking.schemas.js'
import * as routingService from '../routing/routing.service.js'

export async function board(req, res) {
  const result = await trackingService.inTransitBoard()
  res.status(200).json(result)
}

// Static reference data -- no database, no await. Kept off the board so a
// 10s poll never carries a list only a deploy can change.
export function map(_req, res) {
  res.status(200).json(trackingService.mapReference())
}

// The fleet map's A→B lane search: query params, JSON out. No list of
// every posting -- the ranked top of the market is what a dispatcher
// acts on; the full board is one click away in the nav.
export async function laneSearch(req, res) {
  const { origin, destination } = req.query
  const result = await trackingService.searchLane({
    origin: typeof origin === 'string' ? origin : undefined,
    destination: typeof destination === 'string' ? destination : undefined,
  })
  res.status(200).json(result)
}

// Type-ahead for the search boxes -- cheap, static, no DB. Kept as its
// own endpoint so the page can complete as the user types without
// waiting on the postings read the actual search runs.
export function cityCompletions(req, res) {
  res.status(200).json(trackingService.searchCompletions(req.query.q))
}

// GET /tracking/route -- the actual road geometry for one lane, read
// through routing.service.js's cache. Separate endpoint from the board
// (not folded into /tracking/) because a route is fetched once per lane
// and reused by every load on it -- it doesn't belong on a 10s poll any
// more than /tracking/map's city list does.
export async function route(req, res) {
  const { originCity, originState, destinationCity, destinationState } = routeQuerySchema.parse(req.query)
  const routes = await routingService.routesFor(
    { city: originCity, state: originState },
    { city: destinationCity, state: destinationState },
  )
  res.status(200).json({ routes })
}

// GET /tracking/loads/:loadId/route -- the FULL road geometry for ONE
// selected load, fetched once (not on the 10s poll -- see
// tracking.service.js's BOARD_TOLERANCE_MI header) when a dispatcher
// actually picks that load on the board. See trackingService.loadRoute's
// own header for the two loud failure modes (LOAD_NOT_FOUND /
// UNKNOWN_CITY / ROUTE_UNAVAILABLE) -- none of them are caught here,
// same as every other handler in this file; the error middleware turns
// an AppError into the right HTTP status.
export async function loadRoute(req, res) {
  const { loadId } = loadRouteParamsSchema.parse(req.params)
  const result = await trackingService.loadRoute(loadId)
  res.status(200).json(result)
}

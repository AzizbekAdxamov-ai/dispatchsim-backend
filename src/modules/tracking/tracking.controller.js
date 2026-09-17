// HTTP layer for /tracking. No business logic -- see tracking.service.js.
// The route already sits behind requireAuth + requireRole().

import * as trackingService from './tracking.service.js'

export async function board(req, res) {
  const result = await trackingService.inTransitBoard()
  res.status(200).json(result)
}

// Static reference data -- no database, no await. Kept off the board so a
// 10s poll never carries a list only a deploy can change.
export function map(_req, res) {
  res.status(200).json(trackingService.mapReference())
}

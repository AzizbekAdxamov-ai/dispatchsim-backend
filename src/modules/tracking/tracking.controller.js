// HTTP layer for /tracking. No business logic -- see tracking.service.js.
// The route already sits behind requireAuth + requireRole().

import * as trackingService from './tracking.service.js'

export async function board(req, res) {
  const result = await trackingService.inTransitBoard()
  res.status(200).json(result)
}

// HTTP layer for /stats. No SQL, no business logic — see
// stats.service.js. Already behind requireAuth + requireRole() (see
// stats.routes.js).

import * as statsService from './stats.service.js'

export async function getDashboard(req, res) {
  const result = await statsService.getDashboard()
  res.status(200).json(result)
}

// GET /stats/compliance -- Compliance > Overview
export async function getComplianceOverview(req, res) {
  const result = await statsService.getComplianceOverview()
  res.status(200).json(result)
}

// HTTP layer for /compliance. No SQL, no rules -- see compliance.service.js.

import * as service from './compliance.service.js'
import { driverLogParamsSchema, driverLogQuerySchema, violationsQuerySchema } from './compliance.schemas.js'

// GET /compliance/hos
export async function driverHos(req, res) {
  res.status(200).json(await service.listDriverHos())
}

// GET /compliance/hos/:driverId/log?day=0
export async function driverLog(req, res) {
  const { driverId } = driverLogParamsSchema.parse(req.params)
  const { day } = driverLogQuerySchema.parse(req.query)
  res.status(200).json(await service.driverDayLog({ driverId, dayOffset: day }))
}

// GET /compliance/violations?days=7
export async function violations(req, res) {
  const { days } = violationsQuerySchema.parse(req.query)
  res.status(200).json(await service.listViolations({ days }))
}

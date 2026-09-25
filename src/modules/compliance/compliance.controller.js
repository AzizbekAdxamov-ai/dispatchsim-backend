// HTTP layer for /compliance. No SQL, no rules -- see compliance.service.js.

import * as service from './compliance.service.js'
import {
  driverLogParamsSchema, driverLogQuerySchema, violationsQuerySchema,
  dutyEventIdSchema, reviewAssignSchema, reviewAnnotationSchema,
} from './compliance.schemas.js'

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

// GET /compliance/driver-qualification
export async function driverQualification(req, res) {
  res.status(200).json(await service.listDriverQualification())
}

// GET /compliance/unassigned-hos
export async function unassignedHos(req, res) {
  res.status(200).json(await service.listUnassignedHos())
}

// POST /compliance/unassigned-hos/:id/assign
export async function assignUnassignedHos(req, res) {
  const { id } = dutyEventIdSchema.parse(req.params)
  const { driverId, annotation } = reviewAssignSchema.parse(req.body)
  res.status(200).json(await service.assignUnassignedHos({ eventId: id, driverId, annotation }))
}

// POST /compliance/unassigned-hos/:id/annotate
export async function annotateUnassignedHos(req, res) {
  const { id } = dutyEventIdSchema.parse(req.params)
  const { annotation } = reviewAnnotationSchema.parse(req.body)
  res.status(200).json(await service.annotateUnassignedHos({ eventId: id, annotation }))
}

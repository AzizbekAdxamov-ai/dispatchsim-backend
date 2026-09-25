// HTTP layer for /fleet/*. No SQL, no business logic — see
// fleet.service.js and the trucks/maintenance/metrics repositories. Every
// route is already behind requireAuth + requireRole('fleet-manager') (see
// fleet.routes.js).

import {
  truckIdSchema, trucksQuerySchema, maintenanceQuerySchema,
  refuelSchema, serviceIdSchema, dvirIdSchema, dvirCertifySchema,
} from './fleet.schemas.js'
import * as fleetService from './fleet.service.js'
import * as dvirService from './dvir.service.js'

export async function listTrucks(req, res) {
  const input = trucksQuerySchema.parse(req.query)
  const result = await fleetService.listTrucks(input)
  res.status(200).json(result)
}

export async function getTruck(req, res) {
  const id = truckIdSchema.parse(req.params.id)
  const truck = await fleetService.getTruckById(id)
  res.status(200).json(truck)
}

export async function listMaintenance(req, res) {
  const input = maintenanceQuerySchema.parse(req.query)
  const result = await fleetService.listMaintenance(input)
  res.status(200).json(result)
}

export async function refuel(req, res) {
  const id = truckIdSchema.parse(req.params.id)
  const { toPct } = refuelSchema.parse(req.body ?? {})
  const result = await fleetService.refuel({ truckId: id, toPct, userId: req.auth.userId })
  res.status(200).json(result)
}

export async function completeService(req, res) {
  const id = serviceIdSchema.parse(req.params.id)
  const result = await fleetService.performService({ recordId: id, userId: req.auth.userId })
  res.status(200).json(result)
}

// GET /fleet/dvir -- the inspection reports, newest first, each carrying
// the 396.13 certification decision the next driver's sign-off answers to.
export async function listDvir(req, res) {
  const result = await dvirService.listReports()
  res.status(200).json(result)
}

// POST /fleet/dvir/:id/certify -- 396.13(b)(2): the next driver signs the
// last report's defects off as fixed. The rule lives in the constants
// module; this endpoint is the write.
export async function certifyDvir(req, res) {
  const id = dvirIdSchema.parse(req.params.id)
  const { driverId } = dvirCertifySchema.parse(req.body)
  const result = await dvirService.certifyReport({ reportId: id, driverId })
  res.status(200).json(result)
}

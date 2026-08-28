// HTTP layer for /fleet/*. No SQL, no business logic — see
// fleet.service.js and the trucks/maintenance/metrics repositories. Every
// route is already behind requireAuth + requireRole('fleet-manager') (see
// fleet.routes.js).

import { truckIdSchema, trucksQuerySchema, maintenanceQuerySchema } from './fleet.schemas.js'
import * as fleetService from './fleet.service.js'

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

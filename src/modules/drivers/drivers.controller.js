// HTTP layer for /drivers. No SQL, no business logic — see
// drivers.service.js / drivers.repository.js. Every route is already
// behind requireAuth + requireRole() (see drivers.routes.js).

import { listQuerySchema, driverIdSchema } from './drivers.schemas.js'
import * as driversService from './drivers.service.js'

export async function listDrivers(req, res) {
  const input = listQuerySchema.parse(req.query)
  const result = await driversService.listDrivers(input)
  res.status(200).json(result)
}

export async function getDriver(req, res) {
  const id = driverIdSchema.parse(req.params.id)
  const driver = await driversService.getDriverById(id)
  res.status(200).json(driver)
}

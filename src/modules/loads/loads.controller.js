// HTTP layer for /loads. No SQL, no business logic here — that lives in
// loads.service.js and loads.repository.js. Every route is already behind
// requireAuth + requireRole() (see loads.routes.js).

import { listQuerySchema, loadIdSchema, dispatchLoadSchema } from './loads.schemas.js'
import * as loadsService from './loads.service.js'
import * as dispatchService from './dispatch.service.js'

export async function listLoads(req, res) {
  const input = listQuerySchema.parse(req.query)
  const result = await loadsService.listLoads(input)
  res.status(200).json(result)
}

export async function getLoad(req, res) {
  const id = loadIdSchema.parse(req.params.id)
  const load = await loadsService.getLoadById(id)
  res.status(200).json(load)
}

// POST /loads/:id/dispatch — put a driver on it and start the clock.
// This is the first write endpoint on /loads: until now a booked load had
// no way to become a delivered one.
// POST /loads/:id/cancel — take the load back off the driver.
export async function cancelDispatch(req, res) {
  const id = loadIdSchema.parse(req.params.id)
  const result = await dispatchService.cancelDispatch({ loadId: id })
  res.status(200).json(result)
}

export async function dispatchLoad(req, res) {
  const id = loadIdSchema.parse(req.params.id)
  const { driverId } = dispatchLoadSchema.parse(req.body)
  const result = await dispatchService.dispatchLoad({ loadId: id, driverId, userId: req.auth.userId })
  res.status(200).json(result)
}

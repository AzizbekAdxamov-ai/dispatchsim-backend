// HTTP layer for /loads. No SQL, no business logic here — that lives in
// loads.service.js and loads.repository.js. Every route is already behind
// requireAuth + requireRole() (see loads.routes.js).

import { listQuerySchema, loadIdSchema } from './loads.schemas.js'
import * as loadsService from './loads.service.js'

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

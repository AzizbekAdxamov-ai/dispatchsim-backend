import { checkMcSchema } from './brokerCheck.schemas.js'
import * as service from './brokerCheck.service.js'

// POST /broker-check — run an MC number. Always 200: "no record found" is
// an answer, not a failure, and it is journalled the same as a hit.
export async function checkMc(req, res) {
  const { mcNumber } = checkMcSchema.parse(req.body)
  const result = await service.checkMc({ userId: req.auth.userId, mcNumber })
  res.status(200).json(result)
}

// GET /broker-check — the journal of everything this dispatcher looked up.
export async function listChecks(req, res) {
  const result = await service.listChecks({ userId: req.auth.userId })
  res.status(200).json(result)
}

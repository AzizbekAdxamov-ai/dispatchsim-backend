import { listEntriesSchema } from './cash.schemas.js'
import * as service from './cash.service.js'

// GET /cash — balance, what it is made of, and what is still owed.
export async function getOverview(req, res) {
  res.status(200).json(await service.getOverview())
}

// GET /cash/ledger — the transactions themselves.
export async function listEntries(req, res) {
  const { limit, kind } = listEntriesSchema.parse(req.query)
  res.status(200).json(await service.listEntries({ limit, kind: kind ?? null }))
}

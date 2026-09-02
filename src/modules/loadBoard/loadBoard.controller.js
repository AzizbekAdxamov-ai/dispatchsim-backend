// HTTP layer for /load-board. No SQL, no business logic here — that lives in
// loadBoard.service.js and loadBoard.repository.js. Every route is already
// behind requireAuth + requireRole() (see loadBoard.routes.js).

import { listPostingsSchema, postingDetailQuerySchema, postingIdSchema, bookPostingSchema } from './loadBoard.schemas.js'
import * as loadBoardService from './loadBoard.service.js'
import * as loadBoardRepo from './loadBoard.repository.js'

export async function listPostings(req, res) {
  const input = listPostingsSchema.parse(req.query)
  const result = await loadBoardService.listPostings(input)
  res.status(200).json(result)
}

export function listCities(_req, res) {
  res.status(200).json(loadBoardRepo.listCities())
}

export async function getPosting(req, res) {
  const id = postingIdSchema.parse(req.params.id)
  const where = postingDetailQuerySchema.parse(req.query)
  const posting = await loadBoardService.getPostingById(id, where)
  res.status(200).json(posting)
}

// POST /load-board/:id/book — book a posting, creating a load.
// Idempotent: same user re-booking returns 200 with existing load.
// Fix 2: unified response shape { load, posting, warnings } for both codes.
// Fix 4: truckId removed from schema — resolved server-side.
export async function bookPosting(req, res, next) {
  try {
    const postingId = postingIdSchema.parse(req.params.id)
    const { driverId } = bookPostingSchema.parse(req.body)
    const userId = req.auth.userId

    const result = await loadBoardService.bookPosting({ postingId, userId, driverId })

    res.status(result.isNew ? 201 : 200).json({
      load: result.load,
      posting: result.posting,
      warnings: result.warnings,
    })
  } catch (err) {
    next(err)
  }
}

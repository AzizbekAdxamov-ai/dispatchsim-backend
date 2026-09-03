// HTTP layer for /load-board. No SQL, no business logic here — that lives in
// loadBoard.service.js and loadBoard.repository.js. Every route is already
// behind requireAuth + requireRole() (see loadBoard.routes.js).

import { listPostingsSchema, postingDetailQuerySchema, postingIdSchema } from './loadBoard.schemas.js'
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

// There is no booking controller here any more (2026-09-02). A load is
// created by accepting a rate confirmation in the broker thread, so the
// HTTP entry point lives in brokerChat.controller.acceptRateCon. Leaving a
// live /book endpoint behind would be a way to create a load without ever
// talking to the broker — the one thing this design is built to prevent.

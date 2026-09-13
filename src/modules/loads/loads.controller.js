// HTTP layer for /loads. No SQL, no business logic here — that lives in
// loads.service.js and loads.repository.js. Every route is already behind
// requireAuth + requireRole() (see loads.routes.js).

import { listQuerySchema, loadIdSchema, dispatchLoadSchema, resolveEventSchema, eventIdSchema } from './loads.schemas.js'
import * as loadsService from './loads.service.js'
import * as loadEventsService from '../loadEvents/loadEvents.service.js'
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

// GET /loads/:id/events — everything that has happened on this run, plus
// the open one with its options priced.
export async function listEvents(req, res) {
  const [events, open] = await Promise.all([
    loadEventsService.listForLoad(req.params.id),
    loadEventsService.getOpenEvent(req.params.id),
  ])
  res.status(200).json({ events, open })
}

// POST /loads/:id/events/:eventId/resolve — choose how to handle it.
//
// The ETA move, the money and the resolution land in one transaction, so a
// student cannot end up paying for a tow that did not happen.
export async function resolveEvent(req, res) {
  const { optionKey } = resolveEventSchema.parse(req.body)
  const { eventId } = eventIdSchema.parse(req.params)
  const loadId = loadIdSchema.parse(req.params.id)
  res.status(200).json(await loadEventsService.resolve({
    eventId,
    // Passed so the service can check the event actually belongs to this
    // load. Without it, POST /loads/9999/events/88/resolve resolved event
    // 88 and charged load 4471's tow -- the id in the path was decoration.
    loadId,
    optionKey,
    userId: req.auth.userId,
  }))
}

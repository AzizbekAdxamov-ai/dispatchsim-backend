import { openSchema, sendSchema } from './driverChat.schemas.js'
import * as service from './driverChat.service.js'

// POST /driver-chat — open (or continue) the thread with one driver.
export async function open(req, res) {
  const { driverId } = openSchema.parse(req.body)
  res.status(200).json(await service.openConversation({ driverId, userId: req.auth.userId }))
}

// GET /driver-chat — every driver, with the last delivered line.
export async function listThreads(req, res) {
  res.status(200).json(await service.listThreads({ userId: req.auth.userId }))
}

// GET /driver-chat/:id — the thread, plus what this driver is owed.
export async function getThread(req, res) {
  res.status(200).json(await service.getThread({
    conversationId: req.params.id,
    userId: req.auth.userId,
  }))
}

// POST /driver-chat/:id/messages — say something. The reply is written now
// and becomes visible later; the response says only that one is coming.
export async function send(req, res) {
  const { text } = sendSchema.parse(req.body)
  res.status(201).json(await service.sendMessage({
    conversationId: req.params.id,
    userId: req.auth.userId,
    text,
  }))
}

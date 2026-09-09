import * as service from './alerts.service.js'
import { ackSchema, unackSchema } from './alerts.schemas.js'

// GET /alerts — everything that is true right now and not acknowledged.
export async function list(req, res) {
  res.status(200).json(await service.listAlerts({ userId: req.auth.userId }))
}

// POST /alerts/ack — "I have seen this."
//
// The fingerprint the client sends is the one it was shown. When the
// situation changes the fingerprint changes with it and the alert comes
// back on its own; nothing has to remember to un-silence it.
export async function ack(req, res) {
  const { alertKey, fingerprint } = ackSchema.parse(req.body)
  res.status(200).json(await service.acknowledge({ userId: req.auth.userId, alertKey, fingerprint }))
}

// POST /alerts/unack — take it back.
export async function unack(req, res) {
  const { alertKey } = unackSchema.parse(req.body)
  const removed = await service.unacknowledge({ userId: req.auth.userId, alertKey })
  res.status(200).json({ removed: Boolean(removed) })
}

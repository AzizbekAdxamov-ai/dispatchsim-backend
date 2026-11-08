// HTTP layer for /broker-chat. No SQL and no model calls here — those live
// in brokerChat.service.js and brokerChat.repository.js.
import {
  conversationIdSchema,
  postingIdSchema,
  sendMessageSchema,
  agreeRateSchema,
} from './brokerChat.schemas.js'
import { loadIdSchema } from '../loads/loads.schemas.js'
import * as service from './brokerChat.service.js'
import { rateConInput } from './rateConInput.js'
import { getCarrier } from '../carrier/carrier.repository.js'

export async function openConversation(req, res) {
  const postingId = postingIdSchema.parse(req.params.postingId)
  const result = await service.openConversation({ postingId, userId: req.auth.userId })
  res.status(200).json(result)
}

// POST /broker-chat/loads/:loadId — the thread behind a booked load.
export async function openLoadConversation(req, res) {
  const loadId = loadIdSchema.parse(req.params.loadId)
  const result = await service.openLoadConversation({ loadId, userId: req.auth.userId })
  res.status(200).json(result)
}

export async function getThread(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const result = await service.getThread({ conversationId, userId: req.auth.userId })
  res.status(200).json(result)
}

export async function sendMessage(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const { text } = sendMessageSchema.parse(req.body)
  const result = await service.sendMessage({ conversationId, userId: req.auth.userId, text })
  res.status(201).json(result)
}

export async function agreeRate(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const { rateUsd } = agreeRateSchema.parse(req.body)
  const conversation = await service.agreeRate({ conversationId, userId: req.auth.userId, rateUsd })
  res.status(200).json({ conversation })
}

// POST /broker-chat/:id/accept — sign the rate confirmation. This is the
// only path that creates a load; the board has no booking button any more.
export async function acceptRateCon(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const result = await service.acceptRateCon({ conversationId, userId: req.auth.userId })
  res.status(result.alreadyAccepted ? 200 : 201).json(result)
}

export async function listConversations(req, res) {
  const result = await service.listConversations({ userId: req.auth.userId })
  res.status(200).json(result)
}

export async function rateConfirmation(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const { generateRateConfirmation } = await import('./rateConfirmation.js')
  const data = await service.getRateConfirmation({ conversationId, userId: req.auth.userId })

  // Who we are, on the paper the broker files: one carrier row, read fresh
  // (a company that renames itself does not have to reissue its documents).
  // What goes where is explained in rateConInput.js.
  const carrier = await getCarrier()
  const pdf = await generateRateConfirmation(rateConInput(data, carrier))

  const docId = conversationId.slice(0, 8)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="rate-confirmation-${docId}.pdf"`)
  res.send(pdf)
}

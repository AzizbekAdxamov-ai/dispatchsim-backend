// HTTP layer for /broker-chat. No SQL and no model calls here — those live
// in brokerChat.service.js and brokerChat.repository.js.
import {
  conversationIdSchema,
  postingIdSchema,
  sendMessageSchema,
  agreeRateSchema,
} from './brokerChat.schemas.js'
import * as service from './brokerChat.service.js'

export async function openConversation(req, res) {
  const postingId = postingIdSchema.parse(req.params.postingId)
  const result = await service.openConversation({ postingId, userId: req.auth.userId })
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

export async function listConversations(req, res) {
  const result = await service.listConversations({ userId: req.auth.userId })
  res.status(200).json(result)
}

export async function rateConfirmation(req, res) {
  const conversationId = conversationIdSchema.parse(req.params.id)
  const { generateRateConfirmation } = await import('./rateConfirmation.js')
  const data = await service.getRateConfirmation({ conversationId, userId: req.auth.userId })

  const pdf = await generateRateConfirmation({
    conversation: { id: data.id, agreedRateUsd: data.agreedRateUsd, updatedAt: data.updatedAt },
    posting: {
      originCity: data.originCity, originState: data.originState,
      destinationCity: data.destinationCity, destinationState: data.destinationState,
      distanceMi: data.distanceMi, equipmentType: data.equipmentType,
      equipmentLengthFt: data.equipmentLengthFt, commodity: data.commodity,
      weightLbs: data.weightLbs, pickupAt: data.pickupAt, deliveryAt: data.deliveryAt,
      bookedLoadId: data.bookedLoadId, rateUsd: data.rateUsd,
    },
    broker: {
      name: data.brokerName, contactName: data.brokerContactName,
      mcNumber: data.mcNumber, creditRating: data.creditRating,
      daysToPay: data.daysToPay,
    },
    user: req.auth,
  })

  const docId = conversationId.slice(0, 8)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="rate-confirmation-${docId}.pdf"`)
  res.send(pdf)
}

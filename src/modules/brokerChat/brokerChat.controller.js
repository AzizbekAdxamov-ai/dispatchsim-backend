// HTTP layer for /broker-chat. No SQL and no model calls here — those live
// in brokerChat.service.js and brokerChat.repository.js.
import {
  conversationIdSchema,
  postingIdSchema,
  sendMessageSchema,
  agreeRateSchema,
} from './brokerChat.schemas.js'
import * as service from './brokerChat.service.js'
import { termsForDaysToPay } from '../../constants/paymentTerms.js'
import { getCarrier, addressLine as carrierAddressLine } from '../carrier/carrier.repository.js'

export async function openConversation(req, res) {
  const postingId = postingIdSchema.parse(req.params.postingId)
  const result = await service.openConversation({ postingId, userId: req.auth.userId })
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

  // Who we are, on the paper the broker files. One row, read fresh: a
  // company that renames itself does not have to reissue its documents.
  const carrier = await getCarrier()

  const pdf = await generateRateConfirmation({
    // rate_con_rate_usd first: this document IS the paper, so it prints
    // what the paper says. When the broker's number came back below the
    // handshake, the difference is visible only to a dispatcher who opens
    // the PDF and compares — which is the point of the step.
    conversation: {
      id: data.id,
      agreedRateUsd: data.rateConRateUsd ?? data.agreedRateUsd,
      updatedAt: data.updatedAt,
    },
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
      mcNumber: data.mcNumber,
      paymentTerms: termsForDaysToPay(data.daysToPay),
    },
    // The CARRIER column was fed `req.auth`, which is only { userId } --
    // so `user?.name || user?.company` was always undefined and every
    // rate confirmation this program has produced named the broker in
    // full and left the carrier as an em dash. The names come out of the
    // users row the query now joins.
    // The company itself comes from the carrier row (048), not from the
    // signing user's free-text `company` field: one fleet has one name
    // and one authority, whichever person happens to sign the paper.
    // The CONTACT is still the person -- that part was always right.
    carrier: {
      name: carrier?.name ?? data.carrierName,
      contactName: data.carrierContactName,
      mcNumber: carrier?.mcNumber ?? null,
      dotNumber: carrier?.dotNumber ?? null,
      addressLine: carrier ? carrierAddressLine(carrier) : null,
      phone: carrier?.phone ?? null,
    },
  })

  const docId = conversationId.slice(0, 8)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="rate-confirmation-${docId}.pdf"`)
  res.send(pdf)
}

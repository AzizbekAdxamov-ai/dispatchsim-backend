// The document the rate confirmation PDF is made from: the conversation row
// (as the service reads it) plus the carrier row, shaped for
// generateRateConfirmation. Pure, so a test can build the same paper the
// download builds without a server.
import { termsForDaysToPay } from '../../constants/paymentTerms.js'
import { addressLine as carrierAddressLine } from '../carrier/carrier.repository.js'
import { paperQuote } from './rateQuote.js'

export function rateConInput(data, carrier) {
  return {
    // rate_con_rate_usd first: this document IS the paper, so it prints
    // what the paper says. When the broker's number came back below the
    // handshake, the difference is visible only to a dispatcher who opens
    // the PDF and compares — which is the point of the step.
    conversation: {
      id: data.id,
      agreedRateUsd: data.rateConRateUsd ?? data.agreedRateUsd,
      ...paperQuote(data),
      updatedAt: data.updatedAt,
    },
    posting: {
      originCity: data.originCity, originState: data.originState,
      destinationCity: data.destinationCity, destinationState: data.destinationState,
      distanceMi: data.distanceMi, equipmentType: data.equipmentType,
      equipmentLengthFt: data.equipmentLengthFt, commodity: data.commodity,
      weightLbs: data.weightLbs, pickupAt: data.pickupAt, deliveryAt: data.deliveryAt,
      bookedLoadId: data.bookedLoadId, rateUsd: data.rateUsd,
      shipper: data.stops.shipper, receiver: data.stops.receiver,
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
      // Only what the dispatcher said in the chat; absent otherwise.
      driverName: data.booking.driverName,
      truckNumber: data.booking.truckNumber,
      dispatcherEmail: data.booking.email,
    },
  }
}

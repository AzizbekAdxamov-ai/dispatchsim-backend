// Build a broker turn the way the live service does: same financial
// decision, compact reference, messages and checker inputs. Used by
// chat:eval (an isolated single turn) and chat:scenarios (a whole
// conversation held in memory, nothing written to the database).
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { dispatcherTexts, brokerTexts } from '../src/modules/brokerChat/brokerChat.service.js'
import { carrierEmail } from '../src/modules/carrier/carrier.repository.js'

// 'agreed' and 'booked' threads count as booked for the reply checks, as in
// the service (BOOKED_STATUSES there).
const BOOKED_STATUSES = Object.freeze(['agreed', 'booked'])

// A thread nobody has spoken in yet.
export const newConversation = () => ({
  status: 'open', agreedRateUsd: null, recipientEmail: null, negotiationStage: 'negotiating',
  brokerOfferUsd: null, ratePushCount: 0, bestCounterUsed: false, pendingCloseUsd: null,
})

// What completeChatTurn stores after a model turn.
export function conversationAfterTurn(conversation, decision) {
  const s = decision.state
  return {
    ...conversation,
    brokerOfferUsd: s.offer, agreedRateUsd: s.agreed, status: s.agreed === null ? 'open' : 'agreed',
    negotiationStage: s.stage, recipientEmail: s.recipient, ratePushCount: s.pushes,
    bestCounterUsed: s.bestCounterUsed, pendingCloseUsd: s.pendingClose ?? null,
  }
}

// What cancelAndBlock / releaseForNoEta store: the agreement is withdrawn.
export function conversationAfterWithdrawal(conversation) {
  return { ...conversation, agreedRateUsd: null, recipientEmail: null, pendingCloseUsd: null, negotiationStage: 'held', status: 'open' }
}

// `thread` already ends with the dispatcher's line `text` (the service reads
// it back after beginChatTurn). `conversation` is the state BEFORE this turn,
// which is what the service hands negotiate().
export function brokerTurnContext({ posting, carrier, thread, conversation, text, now = new Date(), paperDelivered = false }) {
  const said = dispatcherTexts(thread)
  const brokerSaid = brokerTexts(thread)
  const truck = truckFacts({ texts: said, posting, now })
  const booking = bookingFacts({ texts: said, carrier, posting, now })
  const negotiation = negotiate({
    conversation: { ...conversation, negotiationStage: paperDelivered ? 'paper_delivered' : conversation.negotiationStage },
    posting, text, booking, truck, now,
    effectiveEmail: carrierEmail(carrier, null).effectiveEmail,
    offerVisible: brokerSaid.some((line) => line.replaceAll(',', '').includes(String(conversation.brokerOfferUsd ?? posting.rateUsd))),
  })
  const paper = {
    status: negotiation.state.agreed === null ? 'open' : 'agreed',
    delivered: paperDelivered && !negotiation.invalidatePaper,
    stage: negotiation.state.stage,
  }
  const context = buildBrokerContext({
    broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
    posting, carrier, now, thread, said, paper, booking, brokerSaid, negotiation,
  })
  return {
    ...context, negotiation, paper,
    checkFacts: {
      truck, booking, posting, now, text, said, brokerSaid, paper, negotiation,
      bookedHere: BOOKED_STATUSES.includes(conversation.status),
    },
  }
}

// A single isolated turn on a fresh thread.
export function brokerEvalContext({ posting, carrier, text, now = new Date() }) {
  return brokerTurnContext({
    posting, carrier, text, now,
    thread: [{ role: 'dispatcher', content: text, kind: 'text' }],
    conversation: newConversation(),
  })
}

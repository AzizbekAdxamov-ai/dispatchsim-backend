// Build an isolated single turn with the same financial decision, compact
// reference, messages and checker inputs as the live broker service.
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'

export function brokerEvalContext({ posting, carrier, text, now = new Date() }) {
  const thread = [{ role: 'dispatcher', content: text }]
  const truck = truckFacts({ texts: [text], posting, now })
  const booking = bookingFacts({ texts: [text], carrier, posting, now })
  const conversation = { status: 'open', agreedRateUsd: null, recipientEmail: null, negotiationStage: 'negotiating', ratePushCount: 0 }
  const negotiation = negotiate({ conversation, posting, text, booking, truck, now, offerVisible: false })
  const paper = { status: negotiation.state.agreed === null ? 'open' : 'agreed', delivered: false, stage: negotiation.state.stage }
  const context = buildBrokerContext({ broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
    posting, carrier, now, thread, negotiation, paper, truck, booking })
  return { ...context, negotiation, checkFacts: { truck, booking, posting, now, text, said: [text], brokerSaid: [], paper, negotiation, bookedHere: false } }
}

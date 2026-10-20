// An in-memory stand-in for brokerChat.repository.js, for tests that run the
// booking flow through the real service without a database. It keeps the
// rules the SQL keeps (setAgreedRate only from open/agreed, markBooked only
// from agreed with paper) and nothing else.
//
// Not a mock of the service's behaviour: the service is the thing under test,
// this only answers its questions about stored rows.

export const FAKE_IDS = Object.freeze({
  conversation: 'c0ffee00-1111-4222-8333-444455556666',
  posting: 'a1b2c3d4-5555-4666-8777-888899990000',
  user: 'u-test-1',
})

// A posting the gate and the paper can both read: open, live, A-rated broker
// (rateConAmount never lowers the paper), rate inside the 1x-5x band.
export function fakePosting(overrides = {}) {
  const now = Date.now()
  return {
    id: FAKE_IDS.posting,
    originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL',
    commodity: 'Canned goods', rateUsd: 3000, distanceMi: 970, rateHidden: false,
    weightLbs: 38000, equipmentType: 'dry-van', equipmentLengthFt: 53,
    pickupAt: new Date(now + 48 * 3600e3).toISOString(),
    deliveryAt: new Date(now + 96 * 3600e3).toISOString(),
    status: 'open',
    postedAt: new Date(now - 3600e3).toISOString(),
    expiresAt: new Date(now + 72 * 3600e3).toISOString(),
    brokerId: 'broker-1', name: 'Redline Freight Services', contactName: 'Devin',
    persona: 'neutral', creditRating: 'A', mcNumber: 'MC-207863', daysToPay: 30,
    ...overrides,
  }
}

export function makeFakeBrokerRepo({
  posting = fakePosting(),
  userId = FAKE_IDS.user,
  lines = [],
  carrierName = 'Cedar Ridge Transport Services',
  carrierContactName = 'Aziz Adxamov',
} = {}) {
  let seq = 0
  const conversation = {
    id: FAKE_IDS.conversation, postingId: posting.id, userId,
    agreedRateUsd: null, rateConRateUsd: null, status: 'open',
    negotiationStage: 'negotiating', negotiationRevision: 0, brokerOfferUsd: null,
    recipientEmail: null, ratePushCount: 0, bestCounterUsed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const messages = lines.map((content) => ({ id: `m${++seq}`, role: 'dispatcher', content, kind: 'text' }))
  // What a caller sees, like the real CONVERSATION_COLUMNS: no rate con rate.
  const publicRow = () => {
    const { rateConRateUsd, ...rest } = conversation
    return { ...rest }
  }

  const repo = {
    async setProviderRequests() {},
    async hasPendingReply() { return true },
    async getConversation(id, uid) {
      return id === conversation.id && uid === conversation.userId ? publicRow() : null
    },
    async getPostingWithBroker(id) {
      return id === posting.id ? { ...posting } : null
    },
    async listMessages() {
      return messages.filter((m) => !m.deliverAt || new Date(m.deliverAt) <= new Date()).map((m) => ({ ...m }))
    },
    async beginChatTurn(id, uid, text) {
      const { chatIntent } = await import('../../src/modules/brokerChat/negotiation.js')
      const { AppError } = await import('../../src/lib/errors.js')
      if (id !== conversation.id || uid !== conversation.userId) throw new AppError('CONVERSATION_NOT_FOUND')
      if (posting.status !== 'open') throw new AppError('POSTING_TAKEN')
      if (new Date(posting.expiresAt) <= new Date()) throw new AppError('POSTING_EXPIRED')
      conversation.negotiationRevision += 1
      const before = publicRow()
      const intent = chatIntent(text)
      if (['hold', 'walk', 'push'].includes(intent.kind) || (['offer', 'accept_amount'].includes(intent.kind) && conversation.agreedRateUsd !== null && intent.rateUsd !== conversation.agreedRateUsd)) {
        await repo.clearRateCon()
        conversation.agreedRateUsd = null
        conversation.recipientEmail = null
        conversation.status = 'open'
        conversation.negotiationStage = intent.kind === 'hold' ? 'held' : 'negotiating'
      }
      const dispatcherMessage = await repo.addMessage(id, 'dispatcher', text)
      return { conversation: before, dispatcherMessage }
    },
    async completeChatTurn({ revision, decision, reply, delaySec, paperDelaySec, paperRate }) {
      if (conversation.negotiationRevision !== revision) return false
      const s = decision.state
      if (decision.invalidatePaper) await repo.clearRateCon()
      Object.assign(conversation, { brokerOfferUsd: s.offer, agreedRateUsd: s.agreed,
        status: s.agreed === null ? 'open' : 'agreed', negotiationStage: s.stage,
        recipientEmail: s.recipient, ratePushCount: s.pushes, bestCounterUsed: s.bestCounterUsed })
      await repo.addMessage(conversation.id, 'broker', reply, { delaySec })
      if (decision.issuePaper && !messages.some((m) => m.kind === 'rate_con')) {
        conversation.rateConRateUsd = paperRate
        await repo.addMessage(conversation.id, 'broker', 'Rate confirmation attached.', { kind: 'rate_con', delaySec: delaySec + paperDelaySec })
      }
      return true
    },
    async setAgreedRate(id, uid, rateUsd) {
      if (id !== conversation.id || uid !== conversation.userId) return null
      if (!['open', 'agreed'].includes(conversation.status)) return null
      conversation.agreedRateUsd = rateUsd
      conversation.status = 'agreed'
      return publicRow()
    },
    async clearRateCon() {
      conversation.rateConRateUsd = null
      const before = messages.length
      for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].kind === 'rate_con') messages.splice(i, 1)
      return before - messages.length
    },
    async setRateCon(id, rate) {
      if (id !== conversation.id || conversation.status !== 'agreed') return null
      conversation.rateConRateUsd = rate
      return publicRow()
    },
    async addMessage(id, role, content, { kind = 'text', delaySec = 0 } = {}) {
      const row = { id: `m${++seq}`, role, content, kind, deliverAt: new Date(Date.now() + delaySec * 1000).toISOString() }
      messages.push(row)
      return { ...row }
    },
    async rateConDelivered() {
      return messages.some((m) => m.kind === 'rate_con' && (!m.deliverAt || new Date(m.deliverAt) <= new Date()))
    },
    async markBooked(id, uid) {
      if (id !== conversation.id || uid !== conversation.userId) return null
      if (conversation.status !== 'agreed' || conversation.rateConRateUsd == null) return null
      conversation.status = 'booked'
      return publicRow()
    },
    async getConversationForPDF(id, uid) {
      if (id !== conversation.id || uid !== conversation.userId) return null
      return {
        id: conversation.id, agreedRateUsd: conversation.agreedRateUsd,
        rateConRateUsd: conversation.rateConRateUsd, status: conversation.status,
        recipientEmail: conversation.recipientEmail,
        updatedAt: conversation.updatedAt,
        postingId: posting.id,
        originCity: posting.originCity, originState: posting.originState,
        destinationCity: posting.destinationCity, destinationState: posting.destinationState,
        commodity: posting.commodity, rateUsd: posting.rateUsd, distanceMi: posting.distanceMi,
        weightLbs: posting.weightLbs, equipmentType: posting.equipmentType,
        equipmentLengthFt: posting.equipmentLengthFt,
        pickupAt: posting.pickupAt, deliveryAt: posting.deliveryAt,
        bookedLoadId: null,
        brokerName: posting.name, brokerContactName: posting.contactName,
        mcNumber: posting.mcNumber, creditRating: posting.creditRating, daysToPay: posting.daysToPay,
        carrierName, carrierContactName,
      }
    },
  }

  return {
    repo,
    // Test-only handles on the stored state.
    state: { conversation, messages },
    deliverAll() { for (const message of messages) message.deliverAt = new Date(0).toISOString() },
    // Put the thread where a booking left it, without going through the gate
    // (for testing the second gate at accept time).
    forceAgreed(rateUsd) {
      conversation.status = 'agreed'
      conversation.agreedRateUsd = rateUsd
      conversation.rateConRateUsd = rateUsd
      messages.push({ id: `m${++seq}`, role: 'broker', content: 'Rate confirmation attached.', kind: 'rate_con' })
    },
  }
}

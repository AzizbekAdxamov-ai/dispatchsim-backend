// Broker conversation logic.
//
// Provider split: the seed generator runs on Groq (AI_*), the broker chat on
// OpenRouter (CHAT_*). Two different cost shapes — the seed is a predictable
// 22 requests a day, chat is per-message and open-ended — so they get
// separate budgets, keys and models.
import { chatText } from '../../../scripts/seed/aiClient.js'
import { brokerReplyProblem, brokerRetryPrompt } from './replyProblem.js'
import { cancellationDecision, releasedToAnotherTruck, RELEASED_LINE, BLOCK_REASON_ABANDONED_IN_TRANSIT } from './blockPolicy.js'
import { loadStage, LOAD_STAGES, postBookingDecision, POST_BOOKING_ACTIONS } from './postBookingPolicy.js'
import { reportEventFromDispatcher } from '../loadEvents/loadEvents.service.js'
import { truckFacts } from './truckTalk.js'
import { bookingFacts, carrierNotVerified } from './bookingTalk.js'
import { stopsForRow } from './stops.js'
import { fileURLToPath } from 'node:url'
import { promptVersionOf } from '../../lib/promptVersion.js'
import { turnRow, logTurn } from '../chat/turnLog.js'
import { assertCanSend } from '../chat/chatBudget.service.js'
import { chatConfigFor } from '../chat/chatProvider.js'
import { AppError } from '../../lib/errors.js'
import { stripSpeakerLabel } from '../../lib/speakerLabel.js'
import { getCarrier, carrierEmail } from '../carrier/carrier.repository.js'
import { findById } from '../auth/users.repository.js'
import { negotiate, RATE_MISS_REASON } from './negotiation.js'
import { buildBrokerContext } from './brokerContext.js'
import * as repo from './brokerChat.repository.js'
import { talkFacts } from '../../constants/freightTerms.js'
import { replyDelaySec, rateConAmount } from './replyTiming.js'
import { bookPosting } from '../loadBoard/loadBoard.service.js'
import {
  buildMessages,
  FALLBACK_REPLY,
} from './brokerChat.prompt.js'

// Which version of the prompt builder answered (chat_turn_log, 056).
export const PROMPT_VERSION = `${promptVersionOf(fileURLToPath(new URL('./brokerChat.prompt.js', import.meta.url)))}:${promptVersionOf(fileURLToPath(new URL('./brokerContext.js', import.meta.url)))}`

// A conversation with a deal on it: the broker really has a booking here, so
// "already booked" from the dispatcher is not a claim to deny.
const BOOKED_STATUSES = Object.freeze(['agreed', 'booked'])

// The posting has to be live to talk about it: a broker will not discuss a
// load that has expired or has already gone to someone else. Same
// visibility rule as the board, including "not yet dripped" reading as
// not-found rather than expired — an EXPIRED answer for a posting that has
// not appeared yet would confirm it exists.
function assertPostingOpen(posting) {
  if (!posting) throw new AppError('POSTING_NOT_FOUND')
  if (new Date(posting.postedAt) > new Date()) throw new AppError('POSTING_NOT_FOUND')
  if (posting.status !== 'open') throw new AppError('POSTING_TAKEN')
  if (new Date(posting.expiresAt) <= new Date()) throw new AppError('POSTING_EXPIRED')
  if (!posting.brokerId) throw new AppError('BROKER_UNAVAILABLE')
}

// What the booking flow reaches outside this file for. The default is the
// real database; the booking-flow test hands in an in-memory stand-in, so
// the whole agree -> paper -> accept path runs without a DB or a token.
const DEFAULT_DEPS = Object.freeze({ repo, getCarrier, bookPosting, findById, chatText, assertCanSend, chatConfigFor, logTurn, reportRoadEvent: reportEventFromDispatcher })

// No agreement and no signed paper until the MC the dispatcher gave checks
// out (decision 2, 2026-10-17). The broker's own sentence goes to the screen
// in details.message -- the dispatcher is told why, never just refused.
async function assertCarrierVerified(conversationId, posting, deps = DEFAULT_DEPS) {
  const booking = bookingFacts({
    texts: dispatcherTexts(await deps.repo.listMessages(conversationId)),
    carrier: await deps.getCarrier(),
    posting,
  })
  const blocked = carrierNotVerified({ booking, contactName: posting.contactName })
  if (blocked) throw new AppError('CARRIER_NOT_VERIFIED', blocked)
}

export async function openConversation({ postingId, userId }) {
  const posting = await repo.getPostingWithBroker(postingId)
  assertPostingOpen(posting)
  if (await repo.isBrokerBlocked({ brokerId: posting.brokerId, brokerMc: posting.mcNumber })) throw new AppError('BROKER_BLOCKED')

  const conversation = await repo.openConversation(postingId, userId)
  const messages = await repo.listMessages(conversation.id)

  return {
    conversation: { ...conversation, negotiationStage: conversation.status === 'booked' ? 'booked'
      : await repo.rateConDelivered(conversation.id) ? 'paper_delivered' : conversation.negotiationStage },
    messages,
    // The MC number and nothing else. Credit rating and payment days used
    // to ride along here; they are what Broker Check is for now. A chat
    // header that prints the rating hands back exactly what the board
    // stopped giving away, and the dispatcher never learns to look.
    broker: {
      name: posting.name,
      contactName: posting.contactName,
      mcNumber: posting.mcNumber,
    },
    awaitingReply: await repo.hasPendingReply(conversation.id),
  }
}

// Read one thread. openConversation creates-or-opens and is a POST; this
// is the plain read the panel polls, so a refresh does not look like a
// write. Same payload either way, so the client has one shape to render.
// The dispatcher's typed words in a thread. Rate confirmations are
// documents, not things anyone said.
export function dispatcherTexts(messages) {
  return (messages ?? []).filter((m) => m.role === 'dispatcher' && m.kind !== 'rate_con').map((m) => m.content)
}

// What the broker itself has said in a thread (rate confirmations are
// documents, not talk). A figure it already gave is not a new raise.
export function brokerTexts(messages) {
  return (messages ?? []).filter((m) => m.role === 'broker' && m.kind !== 'rate_con').map((m) => m.content)
}

export async function getThread({ conversationId, userId }, { deps = DEFAULT_DEPS } = {}) {
  const repo = deps.repo
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await repo.getPostingWithBroker(conversation.postingId)
  // A blocked broker's thread stays readable (the cancel exchange is in it);
  // only writing to it is refused. A 409 here made the panel lose the
  // thread right after the block (live T5).
  const blocked = (await repo.isBrokerBlocked?.({ brokerId: posting?.brokerId, brokerMc: posting?.mcNumber })) === true

  const messages = await repo.listMessages(conversationId)
  // A booked thread says where its load is (booked, in transit, delivered)
  // so the panel can word the bar above the input.
  const facts = conversation.status === 'booked' ? await repo.bookedLoadFacts?.(conversationId, userId) : null
  return {
    conversation: { ...conversation, negotiationStage: conversation.status === 'booked' ? 'booked'
      : await repo.rateConDelivered(conversation.id) ? 'paper_delivered' : conversation.negotiationStage },
    ...(facts ? { loadStage: loadStage(facts), loadId: facts.id } : {}),
    messages,
    broker: posting && {
      name: posting.name,
      contactName: posting.contactName,
      mcNumber: posting.mcNumber,
    },
    // What the dispatcher has said, as facts: trade words used and the
    // before-booking points raised (src/constants/freightTerms.js).
    talk: posting ? talkFacts(dispatcherTexts(messages), posting.equipmentType) : null,
    awaitingReply: await repo.hasPendingReply(conversationId),
    // The block is the broker's, but a delivered load's own thread stays
    // writable (payment questions), so the panel must not lock it.
    blocked: blocked && (!facts || loadStage(facts) !== LOAD_STAGES.DELIVERED),
  }
}

// The booked-thread path. Fixed lines from recorded facts (postBookingPolicy.js):
// no model, no budget, and nothing here can write the agreed rate.
async function sendPostBooking({ conversation, posting, userId, text, brokerBlocked }, deps) {
  const conversationId = conversation.id
  const thread = await deps.repo.listMessages(conversationId)
  if (releasedToAnotherTruck(thread)) {
    const dispatcherMessage = await deps.repo.addExchange({ conversationId, text, line: RELEASED_LINE })
    return { dispatcherMessage, awaitingReply: false, released: true }
  }
  const facts = await deps.repo.bookedLoadFacts(conversationId, userId)
  const stage = facts ? loadStage(facts) : LOAD_STAGES.BOOKED
  // A block from another load does not cut off this one's own paperwork: a
  // delivered load can still be asked about payment. Any earlier stage
  // stays refused.
  if (brokerBlocked && stage !== LOAD_STAGES.DELIVERED) throw new AppError('BROKER_BLOCKED')
  const decision = postBookingDecision({ stage, text, thread, load: facts, openEvent: facts?.openEvent })
  const exchange = { conversationId, text, line: decision.line }
  const sent = { awaitingReply: false, action: decision.action, loadStage: stage }

  if (decision.action === 'block' || decision.action === POST_BOOKING_ACTIONS.ABANDON) {
    const dispatcherMessage = await deps.repo.cancelAndBlock({
      ...exchange, brokerId: posting?.brokerId, brokerMc: posting?.mcNumber, brokerContact: posting?.contactName,
      ...(decision.action === POST_BOOKING_ACTIONS.ABANDON ? { reason: BLOCK_REASON_ABANDONED_IN_TRANSIT } : {}),
    })
    return { ...sent, dispatcherMessage, blocked: true }
  }
  if (decision.action === 'reclaim') {
    const dispatcherMessage = await deps.repo.releaseForNoEta(exchange)
    return { ...sent, dispatcherMessage, blocked: false, recovered: true }
  }
  if (decision.action === POST_BOOKING_ACTIONS.TROUBLE && decision.eventType && !facts.openEvent) {
    // The road event stops the load the same way a rolled one does. A failure
    // to record it must not lose the exchange the dispatcher just had.
    try {
      await deps.reportRoadEvent({ loadId: facts.id, eventType: decision.eventType, load: facts })
    } catch (e) {
      console.error(`[brokerChat] could not raise ${decision.eventType} on ${facts.id}: ${e.message}`)
    }
  }
  const dispatcherMessage = await deps.repo.addExchange(exchange)
  return { ...sent, dispatcherMessage, blocked: false, ...(decision.action === 'ask_eta' ? { waitingForEta: true } : {}) }
}

export async function sendMessage({ conversationId, userId, text }, { deps = DEFAULT_DEPS } = {}) {
  const conversation = await deps.repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await deps.repo.getPostingWithBroker(conversation.postingId)
  const brokerBlocked = (await deps.repo.isBrokerBlocked?.({ brokerId: posting?.brokerId, brokerMc: posting?.mcNumber })) === true
  // A booked deal stays open for real talk (trouble on the road, payment,
  // cancelling) but is never negotiated again: its own path, no model call.
  if (conversation.status === 'booked') return sendPostBooking({ conversation, posting, userId, text, brokerBlocked }, deps)
  if (brokerBlocked) throw new AppError('BROKER_BLOCKED')
  // Server-side cancellation policy, decided before any model call: a
  // cancel blocks the broker, "can you wait" asks for an ETA and, with no
  // ETA, takes the load back. The model never sees these turns.
  const policyThread = await deps.repo.listMessages(conversationId)
  const policy = cancellationDecision({
    status: conversation.status,
    text,
    brokerSaid: brokerTexts(policyThread),
    thread: policyThread,
  })
  if (policy) {
    const exchange = { conversationId, text, line: policy.line }
    if (policy.action === 'block') {
      const dispatcherMessage = await deps.repo.cancelAndBlock({
        ...exchange, brokerId: posting?.brokerId, brokerMc: posting?.mcNumber, brokerContact: posting?.contactName,
      })
      return { dispatcherMessage, awaitingReply: false, blocked: true }
    }
    if (policy.action === 'reclaim') {
      const dispatcherMessage = await deps.repo.releaseForNoEta(exchange)
      return { dispatcherMessage, awaitingReply: false, blocked: false, recovered: true }
    }
    const dispatcherMessage = await deps.repo.addExchange(exchange)
    return { dispatcherMessage, awaitingReply: false, blocked: false, waitingForEta: true }
  }
  // The load was released to another truck on an earlier turn: the broker
  // does not take it back. A fixed line, no model call, no budget spent.
  if (releasedToAnotherTruck(policyThread)) {
    const dispatcherMessage = await deps.repo.addExchange({ conversationId, text, line: RELEASED_LINE })
    return { dispatcherMessage, awaitingReply: false, released: true }
  }
  assertPostingOpen(posting)

  // Shared with the driver chat and derived from the provider's published
  // daily limit -- see src/constants/chatBudget.js. One budget, counted
  // across both, because one key pays for both.
  await deps.assertCanSend(userId, 'broker')

  const config = deps.chatConfigFor('broker')

  // Persist the dispatcher's turn BEFORE calling the model. If the call
  // fails, what they typed is still in the thread — losing a person's own
  // words to someone else's outage is not acceptable.
  const reserved = await deps.repo.beginChatTurn(conversationId, userId, text)
  const dispatcherMessage = reserved.dispatcherMessage
  const turnConversation = reserved.conversation

  const thread = await deps.repo.listMessages(conversationId)
  const carrier = await deps.getCarrier()
  // The dispatcher's own words so far, this one included. Read by code for
  // market claims and rate pushes (rateTalk.js). Semantic memory below
  // reads the whole thread rather than dropping early caller facts.
  const said = dispatcherTexts(thread)
  // One clock for the prompt and for the check below: the verdict on the
  // reply must be the one the prompt's truck block was written from.
  const now = new Date()
  const truck = truckFacts({ texts: said, posting, now })
  // Who is calling and what is still missing before a booking, from the WHOLE
  // thread (not the 20-turn history): an MC told on message 3 stays told.
  const booking = bookingFacts({ texts: dispatcherTexts(thread), carrier, posting, now })
  // What the broker already said: read by the prompt (has the MC been asked
  // for?) and by the reply checks (a figure it gave before is not a raise).
  const brokerSaid = brokerTexts(thread)
  // An agreed status is not proof the delayed document has arrived.
  const delivered = await deps.repo.rateConDelivered(conversationId)
  const decision = negotiate({
    conversation: { ...turnConversation, negotiationStage: delivered ? 'paper_delivered' : turnConversation.negotiationStage },
    posting, text, booking, truck, now,
    effectiveEmail: carrierEmail(carrier, await deps.findById(userId)).effectiveEmail,
    offerVisible: brokerSaid.some((line) => line.replaceAll(',', '').includes(String(turnConversation.brokerOfferUsd ?? posting.rateUsd))),
  })
  const paper = { status: decision.state.agreed === null ? 'open' : 'agreed', delivered: delivered && !decision.invalidatePaper, stage: decision.state.stage }
  // Build one semantic context for both attempts and log exactly that context.
  // Raw assistant history used to teach the model to repeat old MC mistakes.
  const { systemPrompt, history } = buildBrokerContext({
    carrier,
    broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
    posting,
    now,
    thread,
    said,
    paper,
    booking,
    brokerSaid,
    negotiation: decision,
  })

  // Every request this turn sends to the provider, counted where they are
  // sent (aiClient's onRequest) and written onto the dispatcher's row once
  // the turn is over -- the daily budget is their sum (055).
  let spent = 0
  const onRequest = () => { spent += 1 }
  // For the turn's record (chat_turn_log): why the first reply was
  // regenerated, and the error if the turn failed.
  let regenerated = null
  let failure = null
  let usedFallback = false
  // The model that actually answered, which is the fallback when the
  // primary was throttled; the turn log records that one.
  let answeredModel = config.model
  let answeredSystemPrompt = systemPrompt
  const onModel = (model) => { answeredModel = model }
  // What each request came to (060): status, 429 reason, tokens. Numbered
  // across the whole turn, the regeneration included.
  const attempts = []
  const onAttempt = (a) => attempts.push({ ...a, n: attempts.length + 1 })

  // Everything brokerReplyProblem needs to judge the reply, for the first
  // reply and the regenerated one alike.
  const checkFacts = {
    truck, booking, posting, now, text, said, brokerSaid, paper, negotiation: decision, bookedHere: BOOKED_STATUSES.includes(conversation.status),
  }

  let reply
  try {
    // The contact's own name as a leading "Devin:" is removed before any
    // check or save -- see src/lib/speakerLabel.js.
    const clean = (t) => stripSpeakerLabel(t, posting.contactName)
    reply = clean(await deps.chatText({
      messages: buildMessages({ systemPrompt, history, newMessage: text, negotiation: decision }),
      config,
      onRequest,
      onModel,
      onAttempt,
    }))

    // What is wrong with a reply is decided in replyProblem.js, the same
    // function the eval scripts use. Banned word, leaked reasoning and a
    // too-long reply are unusable: regenerated once, then replaced with a
    // short in-character line -- someone is waiting for an answer, so they
    // cannot be silently dropped the way a bad seed row can. A content
    // problem (the truck cannot reach the pickup and the reply never says
    // so) is regenerated once, with one more request from the daily budget,
    // and logged if it persists.
    const problem = brokerReplyProblem(reply, checkFacts)
    const why = problem?.why ?? null

    if (why) {
      console.warn(`[brokerChat] retrying — reply ${why}`)
      regenerated = why
      answeredSystemPrompt = brokerRetryPrompt(systemPrompt, problem)
      reply = clean(await deps.chatText({
        messages: buildMessages({
          systemPrompt: answeredSystemPrompt,
          history,
          newMessage: text,
          negotiation: decision,
        }),
        config,
        onRequest,
        onModel,
        onAttempt,
        cause: 'regenerate',
      }))
      const remaining = brokerReplyProblem(reply, checkFacts)
      if (remaining?.unusable) {
        // Second layer for a price: a regenerated reply that still misquotes
        // the rate is never sent. The server's own line goes out instead,
        // whatever safeReply carries, because model text cannot be trusted.
        reply = remaining.safeReply ?? decision.line ?? FALLBACK_REPLY
        if (remaining.why === RATE_MISS_REASON && decision.line) reply = decision.line
        usedFallback = true
      }
      else if (remaining) console.warn(`[brokerChat] regenerated reply still ${remaining.why}`)
    }
  } catch (err) {
    failure = err.message
    console.error(`[brokerChat] model call failed: ${err.message}`)
    // The provider ran out before the app's own budget did. Saying the
    // broker cannot be reached would be a sentence about a person who is
    // standing right there; what happened is that the account is out of
    // requests, which is a different fact with a different answer.
    if (err.quotaExhausted) {
      throw new AppError('CHAT_DAILY_LIMIT', {
        message: "The provider's daily request limit is used up. It resets tomorrow."
          + (err.providerMessage ? ` (${err.providerMessage})` : ''),
        source: 'provider',
      })
    }
    // A provider 429 without an explicit daily-cap message may be a busy
    // upstream model. The broker did not cause the failed response.
    if (err.rateLimited) throw new AppError('CHAT_PROVIDER_BUSY')
    throw new AppError('CHAT_UNAVAILABLE')
  } finally {
    // Not allowed to replace the error the dispatcher is about to see, and
    // not allowed to vanish either: a turn whose cost was not written is
    // charged the default of one, which undercounts only that turn.
    await deps.repo.setProviderRequests(dispatcherMessage.id, spent).catch((e) => {
      console.error(`[brokerChat] could not record ${spent} provider request(s) on message ${dispatcherMessage.id}: ${e.message}`)
    })
    // The turn's record, for grading and training (056). Same rule as
    // above: never replaces the dispatcher's error, never vanishes.
    await deps.logTurn(turnRow({
      chat: 'broker', conversationId, dispatcherMessageId: dispatcherMessage.id, userId,
      model: answeredModel, promptVersion: PROMPT_VERSION, systemPrompt: answeredSystemPrompt, history, text,
      imageCount: 0, reply, regeneratedBecause: regenerated,
      fellBack: usedFallback, error: failure, providerRequests: spent,
      attempts, onTheRoad: false,
    })).catch((e) => {
      console.error(`[brokerChat] could not write the turn log for message ${dispatcherMessage.id}: ${e.message}`)
    })
  }

  // The reply is written now and shown later. Generating it up front means
  // the token is spent once, on the turn that caused it, and the wait is a
  // database fact rather than a timer in a browser tab that a reload would
  // skip. The trade is that the broker cannot see a follow-up sent during
  // the wait -- which is exactly what happens with a real broker who has
  // already hit send.
  // If a reply is already waiting to be delivered, this one replaces it in
  // the same slot rather than stacking a second answer behind it -- see
  // replacePendingReply. Only when nothing is pending does the broker draw
  // a fresh delay.
  await deps.repo.completeChatTurn({
    conversationId, userId, revision: turnConversation.negotiationRevision, decision, reply: reply.trim(),
    delaySec: replyDelaySec(posting.creditRating), paperDelaySec: replyDelaySec(posting.creditRating),
    paperRate: decision.issuePaper ? rateConAmount(decision.state.agreed, posting.creditRating, { minRate: posting.distanceMi }) : null,
  })

  // brokerMessage is deliberately NOT returned. Handing the caller a
  // message it is not allowed to show yet is how a delay becomes a bug.
  return { dispatcherMessage, awaitingReply: true }
}

// The dispatcher records what they settled on. Not parsed from the broker's
// prose on purpose — pulling a number out of free text is fragile, and a
// wrong number here quietly changes what the load is worth.
export async function agreeRate({ conversationId, userId, rateUsd }, { deps = DEFAULT_DEPS } = {}) {
  const conversation = await deps.repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await deps.repo.getPostingWithBroker(conversation.postingId)
  assertPostingOpen(posting)

  // loads_rpm_band (migration 007) requires rate_usd between distance and
  // distance * 5. Catching it here means a bad number fails on the agree
  // click with a clear message, instead of surfacing much later as an
  // unexplained booking failure.
  const minRate = posting.distanceMi
  const maxRate = posting.distanceMi * 5
  if (rateUsd < minRate || rateUsd > maxRate) {
    throw new AppError('RATE_OUT_OF_BAND',
      `Rate must be between $${minRate} and $${maxRate} for ${posting.distanceMi} miles`)
  }

  if (conversation.status === 'booked') throw new AppError('ALREADY_BOOKED')
  await assertCarrierVerified(conversationId, posting, deps)

  // Backward-compatible read only: a caller cannot create its own handshake or paper.
  if (conversation.agreedRateUsd !== rateUsd || conversation.status !== 'agreed') {
    throw new AppError('NOT_AGREED_YET')
  }
  return { ...conversation, awaitingReply: await deps.repo.hasPendingReply(conversationId) }
}

// The dispatcher signs the paper. This -- not a button on the board -- is
// what brings a load into existence: negotiate, get the rate confirmation,
// read it, accept it. bookPosting reads the rate con's own number through
// getAgreedRate, so a document that came back low produces a load worth
// exactly that much.
export async function acceptRateCon({ conversationId, userId }, { deps = DEFAULT_DEPS } = {}) {
  const conversation = await deps.repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  // Idempotent: a second click, or a second tab, gets the same load back
  // instead of a second load or an error.
  if (conversation.status === 'booked') {
    // bookPosting is idempotent for the same user and hands back the load
    // it already created, so the reply has the same shape either way --
    // a caller should not have to branch on whether it got there first.
    const again = await deps.bookPosting({ postingId: conversation.postingId, userId, driverId: null })
    return { conversation, load: again.load, warnings: again.warnings, alreadyAccepted: true }
  }

  if (conversation.status !== 'agreed') throw new AppError('NOT_AGREED_YET')
  if (!(await deps.repo.rateConDelivered(conversationId))) throw new AppError('RATE_CON_NOT_ARRIVED')

  const posting = await deps.repo.getPostingWithBroker(conversation.postingId)
  assertPostingOpen(posting)
  await assertCarrierVerified(conversationId, posting, deps)

  // No driver here on purpose. Accepting the paper commits the company to
  // the freight; deciding who runs it is dispatch's next decision, made
  // against the whole fleet rather than in a chat window.
  const booked = await deps.bookPosting({ postingId: conversation.postingId, userId, driverId: null,
    agreement: { conversationId, revision: conversation.negotiationRevision ?? 0 } })

  // The load is already committed at this point. If the status update
  // loses a race with another tab, that is not a reason to report failure
  // and strand the thread on 'agreed' -- the posting is booked, and a
  // second accept would then hit POSTING_TAKEN forever. Report what is
  // true: the load exists.
  const marked = await deps.repo.markBooked(conversationId, userId)
  if (!marked) {
    console.warn(`[brokerChat] load ${booked.load?.id} created but conversation ${conversationId} was not marked booked`)
  }

  return {
    conversation: marked ?? (await deps.repo.getConversation(conversationId, userId)),
    load: booked.load,
    warnings: booked.warnings,
    alreadyAccepted: false,
  }
}

// The thread behind a booked load, from the load page. Opens it if the
// booking never made one; a load this user did not book has none.
export async function openLoadConversation({ loadId, userId }, { deps = DEFAULT_DEPS } = {}) {
  const conversation = await deps.repo.openLoadConversation(loadId, userId)
  if (!conversation) throw new AppError('LOAD_HAS_NO_BROKER_THREAD')
  return { conversation }
}

// The dispatcher's own words when the load page cancels the booking. They go
// through the same booked-thread path as typed text (sendPostBooking), so the
// block, the voided rate con and the cancelled load all come from the one
// policy. "this load" is the object blockPolicy's weak-cancel pattern needs,
// and the text has no price word, so it is never read as a haggle.
// Azizbek qarori 2026-11-08
export const CANCEL_BOOKING_TEXT = 'We have to cancel this load.'

// Cancel the booking with the broker from the load page. Irreversible: the
// broker is told, the rate con is voided, the load is cancelled and the broker
// is blocked. A delivered or already-cancelled load is refused BEFORE any
// message is written.
export async function cancelBookingForLoad({ loadId, userId }, { deps = DEFAULT_DEPS } = {}) {
  const conversation = await deps.repo.openLoadConversation(loadId, userId)
  if (!conversation) throw new AppError('LOAD_HAS_NO_BROKER_THREAD')
  if (conversation.status !== 'booked') throw new AppError('LOAD_NOT_CANCELLABLE')
  const facts = await deps.repo.bookedLoadFacts(conversation.id, userId)
  const stage = facts ? loadStage(facts) : LOAD_STAGES.BOOKED
  if (stage === LOAD_STAGES.DELIVERED || stage === LOAD_STAGES.CANCELLED) throw new AppError('LOAD_NOT_CANCELLABLE')
  const sent = await sendMessage({ conversationId: conversation.id, userId, text: CANCEL_BOOKING_TEXT }, { deps })
  // Anything but a block means the broker did not take it (for example a
  // trouble reply); the thread keeps what was said, the load stays booked.
  if (!sent.blocked) throw new AppError('BOOKING_NOT_CANCELLED')
  return { cancelled: true, conversationId: conversation.id, loadStage: stage }
}

export async function listConversations({ userId }) {
  return { conversations: await repo.listConversations(userId) }
}

export async function getRateConfirmation({ conversationId, userId }, { deps = DEFAULT_DEPS } = {}) {
  const row = await deps.repo.getConversationForPDF(conversationId, userId)
  if (!row) throw new AppError('CONVERSATION_NOT_FOUND')
  if (row.status !== 'agreed' && row.status !== 'booked') throw new AppError('NOT_AGREED_YET')
  // The document cannot be opened before the broker has sent it.
  if (!(await deps.repo.rateConDelivered(conversationId))) throw new AppError('RATE_CON_NOT_ARRIVED')
  // What the dispatcher told the broker (driver, truck number, email for the
  // paper) and the invented shipper and receiver for this posting.
  const booking = bookingFacts({
    texts: dispatcherTexts(await deps.repo.listMessages(conversationId)),
    carrier: await deps.getCarrier(),
    posting: row,
  })
  return { ...row, booking: { ...booking, email: row.recipientEmail ?? booking.email }, stops: stopsForRow(row) }
}

// Broker conversation logic.
//
// Provider split: the seed generator runs on Groq (AI_*), the broker chat on
// OpenRouter (CHAT_*). Two different cost shapes — the seed is a predictable
// 22 requests a day, chat is per-message and open-ended — so they get
// separate budgets, keys and models.
import { readAiConfig } from '../../../scripts/seed/config.js'
import { chatText } from '../../../scripts/seed/aiClient.js'
import { AppError } from '../../lib/errors.js'
import * as repo from './brokerChat.repository.js'
import { replyDelaySec, rateConAmount } from './replyTiming.js'
import { bookPosting } from '../loadBoard/loadBoard.service.js'
import {
  buildBrokerSystemPrompt,
  buildMessages,
  trippedBannedWord,
  leaksReasoning,
  FALLBACK_REPLY,
} from './brokerChat.prompt.js'

// Per-user, per-day cap on dispatcher turns. Not a money guard — at
// OpenRouter's prices $5 buys tens of thousands of messages — but a guard
// against a stuck loop or a bored student burning the free tier's 200/day.
const DAILY_MESSAGE_CAP = 60

// Only the last N turns go to the model. The context window is not the
// constraint (the free models carry 250K+); a broker who still remembers a
// throwaway line from forty messages ago does not read like a person.
const HISTORY_TURNS = 20

function chatConfig() {
  const { config, errors } = readAiConfig({
    prefix: 'CHAT',
    defaults: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'minimax/minimax-m3:free',
    },
  })
  if (!config) throw new AppError('CHAT_UNAVAILABLE', errors.join('; '))
  return config
}

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

export async function openConversation({ postingId, userId }) {
  const posting = await repo.getPostingWithBroker(postingId)
  assertPostingOpen(posting)

  const conversation = await repo.openConversation(postingId, userId)
  const messages = await repo.listMessages(conversation.id)

  return {
    conversation,
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
export async function getThread({ conversationId, userId }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await repo.getPostingWithBroker(conversation.postingId)

  return {
    conversation,
    messages: await repo.listMessages(conversationId),
    broker: posting && {
      name: posting.name,
      contactName: posting.contactName,
      mcNumber: posting.mcNumber,
    },
    awaitingReply: await repo.hasPendingReply(conversationId),
  }
}

export async function sendMessage({ conversationId, userId, text }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await repo.getPostingWithBroker(conversation.postingId)
  assertPostingOpen(posting)

  const sentToday = await repo.countTodaysMessages(userId)
  if (sentToday >= DAILY_MESSAGE_CAP) throw new AppError('CHAT_DAILY_LIMIT')

  const config = chatConfig()

  // Persist the dispatcher's turn BEFORE calling the model. If the call
  // fails, what they typed is still in the thread — losing a person's own
  // words to someone else's outage is not acceptable.
  const dispatcherMessage = await repo.addMessage(conversationId, 'dispatcher', text)

  const history = (await repo.listMessages(conversationId)).slice(-HISTORY_TURNS - 1, -1)
  const systemPrompt = buildBrokerSystemPrompt({
    broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
    posting,
  })

  let reply
  try {
    reply = await chatText({
      messages: buildMessages({ systemPrompt, history, newMessage: text }),
      config,
    })

    // Two ways a reply can be unusable, both regenerated once and then
    // replaced with a short in-character line. Neither can be silently
    // dropped the way a bad seed row can — someone is waiting for an answer.
    //
    // Banned word: breaks the product's own vocabulary rule.
    // Leaked reasoning: the model answers with its own thinking
    //   ("We need to respond as Devin Marlowe...") instead of the broker's
    //   words. Seen live on 2026-08-31 from a 120B model. Nothing destroys
    //   the illusion faster.
    const unusable = (t) => trippedBannedWord(t) !== null || leaksReasoning(t)

    if (unusable(reply)) {
      const why = trippedBannedWord(reply)
        ? 'used a forbidden word'
        : 'showed your own reasoning instead of speaking as the broker'
      console.warn(`[brokerChat] retrying — reply ${why}`)
      reply = await chatText({
        messages: buildMessages({
          systemPrompt: `${systemPrompt}\n\nYour last reply ${why}. Reply again as the broker, in character, one to three sentences only.`,
          history,
          newMessage: text,
        }),
        config,
      })
      if (unusable(reply)) reply = FALLBACK_REPLY
    }
  } catch (err) {
    console.error(`[brokerChat] model call failed: ${err.message}`)
    throw new AppError('CHAT_UNAVAILABLE')
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
  const replaced = await repo.replacePendingReply(conversationId, reply.trim())
  if (!replaced) {
    const delaySec = replyDelaySec(posting.creditRating)
    await repo.addMessage(conversationId, 'broker', reply.trim(), { delaySec })
  }

  // brokerMessage is deliberately NOT returned. Handing the caller a
  // message it is not allowed to show yet is how a delay becomes a bug.
  return { dispatcherMessage, awaitingReply: true }
}

// The dispatcher records what they settled on. Not parsed from the broker's
// prose on purpose — pulling a number out of free text is fragile, and a
// wrong number here quietly changes what the load is worth.
export async function agreeRate({ conversationId, userId, rateUsd }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const posting = await repo.getPostingWithBroker(conversation.postingId)
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

  const updated = await repo.setAgreedRate(conversationId, userId, rateUsd)
  if (!updated) throw new AppError('CONVERSATION_NOT_FOUND')

  // Settling on a new number withdraws whatever paper was already on its
  // way. Without this a dispatcher could re-negotiate up and then accept
  // the old, lower rate confirmation still sitting in the thread.
  await repo.clearRateCon(conversationId)

  // The broker draws up the paper. Sometimes the paper does not say what
  // the handshake said -- see replyTiming.rateConAmount. The load is
  // created at whatever this number is, so reading the document before
  // accepting it is the entire point of the step.
  const paperRate = rateConAmount(rateUsd, posting.creditRating, { minRate })
  const withPaper = await repo.setRateCon(conversationId, paperRate)
  if (!withPaper) throw new AppError('CONVERSATION_NOT_FOUND')

  await repo.addMessage(
    conversationId,
    'broker',
    'Rate confirmation attached. Look it over and send it back signed.',
    { kind: 'rate_con', delaySec: replyDelaySec(posting.creditRating) },
  )

  return { ...withPaper, awaitingReply: true }
}

// The dispatcher signs the paper. This -- not a button on the board -- is
// what brings a load into existence: negotiate, get the rate confirmation,
// read it, accept it. bookPosting reads the rate con's own number through
// getAgreedRate, so a document that came back low produces a load worth
// exactly that much.
export async function acceptRateCon({ conversationId, userId }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  // Idempotent: a second click, or a second tab, gets the same load back
  // instead of a second load or an error.
  if (conversation.status === 'booked') {
    // bookPosting is idempotent for the same user and hands back the load
    // it already created, so the reply has the same shape either way --
    // a caller should not have to branch on whether it got there first.
    const again = await bookPosting({ postingId: conversation.postingId, userId, driverId: null })
    return { conversation, load: again.load, warnings: again.warnings, alreadyAccepted: true }
  }

  if (conversation.status !== 'agreed') throw new AppError('NOT_AGREED_YET')
  if (!(await repo.rateConDelivered(conversationId))) throw new AppError('RATE_CON_NOT_ARRIVED')

  const posting = await repo.getPostingWithBroker(conversation.postingId)
  assertPostingOpen(posting)

  // No driver here on purpose. Accepting the paper commits the company to
  // the freight; deciding who runs it is dispatch's next decision, made
  // against the whole fleet rather than in a chat window.
  const booked = await bookPosting({ postingId: conversation.postingId, userId, driverId: null })

  // The load is already committed at this point. If the status update
  // loses a race with another tab, that is not a reason to report failure
  // and strand the thread on 'agreed' -- the posting is booked, and a
  // second accept would then hit POSTING_TAKEN forever. Report what is
  // true: the load exists.
  const marked = await repo.markBooked(conversationId, userId)
  if (!marked) {
    console.warn(`[brokerChat] load ${booked.load?.id} created but conversation ${conversationId} was not marked booked`)
  }

  return {
    conversation: marked ?? (await repo.getConversation(conversationId, userId)),
    load: booked.load,
    warnings: booked.warnings,
    alreadyAccepted: false,
  }
}

export async function listConversations({ userId }) {
  return { conversations: await repo.listConversations(userId) }
}

export async function getRateConfirmation({ conversationId, userId }) {
  const row = await repo.getConversationForPDF(conversationId, userId)
  if (!row) throw new AppError('CONVERSATION_NOT_FOUND')
  if (row.status !== 'agreed' && row.status !== 'booked') throw new AppError('NOT_AGREED_YET')
  // The document cannot be opened before the broker has sent it.
  if (!(await repo.rateConDelivered(conversationId))) throw new AppError('RATE_CON_NOT_ARRIVED')
  return row
}

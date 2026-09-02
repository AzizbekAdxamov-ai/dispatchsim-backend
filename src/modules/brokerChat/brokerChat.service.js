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
    broker: {
      name: posting.name,
      contactName: posting.contactName,
      mcNumber: posting.mcNumber,
      creditRating: posting.creditRating,
      daysToPay: posting.daysToPay,
    },
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

  const brokerMessage = await repo.addMessage(conversationId, 'broker', reply.trim())
  return { dispatcherMessage, brokerMessage }
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

  const updated = await repo.setAgreedRate(conversationId, userId, rateUsd)
  if (!updated) throw new AppError('CONVERSATION_NOT_FOUND')
  return updated
}

export async function listConversations({ userId }) {
  return { conversations: await repo.listConversations(userId) }
}

export async function getRateConfirmation({ conversationId, userId }) {
  const row = await repo.getConversationForPDF(conversationId, userId)
  if (!row) throw new AppError('CONVERSATION_NOT_FOUND')
  if (row.status !== 'agreed') throw new AppError('NOT_AGREED_YET')
  return row
}

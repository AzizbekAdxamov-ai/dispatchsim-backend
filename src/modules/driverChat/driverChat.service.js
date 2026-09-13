// Talking to a driver.
//
// Mirrors brokerChat.service.js deliberately -- same delayed-reply model,
// same regenerate-once handling of an unusable reply, same "persist the
// dispatcher's turn before calling the model" rule. Two differences, both
// on purpose:
//
//   The thread is per DRIVER and never closes. A broker conversation is
//   about one posting; a driver is someone you work with for months, and
//   the history of what you promised them is the point.
//
//   The driver's stance comes from driver_settlements, read fresh on every
//   turn. It is NOT stored in the thread and NOT decided by the model. If
//   payroll runs between two messages, the next reply is from someone who
//   has just been paid -- because that is what happened.

import { chatText } from '../../../scripts/seed/aiClient.js'
import { assertCanSend } from '../chat/chatBudget.service.js'
import { tooLongForChat, CHAT_REPLY_MAX_CHARS } from '../../constants/chatBudget.js'
import { chatConfigFor } from '../chat/chatProvider.js'
import { AppError } from '../../lib/errors.js'
import { withTransaction } from '../../db/pool.js'
import * as repo from './driverChat.repository.js'
import * as payrollService from '../payroll/payroll.service.js'
import { driverReplyDelaySec } from './driverChat.replyTiming.js'
import {
  buildDriverSystemPrompt,
  buildMessages,
  trippedBannedWord,
  leaksReasoning,
  FALLBACK_REPLY,
} from './driverChat.prompt.js'

// Only the last N turns go to the model. A driver who still remembers a
// throwaway line from forty messages ago does not read like a person.
const HISTORY_TURNS = 20

export async function openConversation({ driverId, userId }) {
  const context = await repo.getDriverContext(driverId)
  if (!context) throw new AppError('DRIVER_NOT_FOUND')
  const conversation = await repo.openConversation(driverId, userId)
  return {
    conversation,
    driver: context.driver,
    messages: await repo.listMessages(conversation.id),
  }
}

export async function getThread({ conversationId, userId }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')
  const context = await repo.getDriverContext(conversation.driverId)
  const standing = await payrollService.driverStanding(null, conversation.driverId)

  return {
    conversation,
    driver: context?.driver ?? null,
    load: context?.load ?? null,
    // Shown beside the thread so the dispatcher can see the same fact the
    // driver is about to raise, rather than being surprised by it.
    standing: {
      owedUsd: standing.owedUsd,
      unpaidCount: standing.unpaidCount,
      daysOverdue: standing.daysOverdue,
      stage: standing.stage,
      willWork: standing.willWork,
    },
    messages: await repo.listMessages(conversationId),
    awaitingReply: await repo.hasPendingReply(conversationId),
  }
}

export async function listThreads({ userId }) {
  return { threads: await repo.listThreads(userId) }
}

export async function sendMessage({ conversationId, userId, text }) {
  const conversation = await repo.getConversation(conversationId, userId)
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND')

  const context = await repo.getDriverContext(conversation.driverId)
  if (!context) throw new AppError('DRIVER_NOT_FOUND')

  // Shared with the broker chat and derived from the provider's published
  // daily limit -- see src/constants/chatBudget.js. Throws with the
  // arithmetic attached, so the screen can say which of the two walls was
  // hit and what the numbers were.
  await assertCanSend(userId, 'driver')

  const config = chatConfigFor('driver')

  // Persist the dispatcher's turn BEFORE calling the model. If the call
  // fails, what they typed is still in the thread -- losing a person's own
  // words to someone else's outage is not acceptable.
  const dispatcherMessage = await repo.addMessage(conversationId, 'dispatcher', text)

  // Read fresh, every turn. A driver who was refusing work two minutes ago
  // and has since been paid is not still refusing, and nothing about that
  // should have to be invalidated by hand.
  const standing = await payrollService.driverStanding(null, conversation.driverId)

  const history = (await repo.listMessages(conversationId)).slice(-HISTORY_TURNS - 1, -1)
  const systemPrompt = buildDriverSystemPrompt({
    driver: context.driver,
    standing,
    load: context.load,
  })

  let reply
  try {
    reply = await chatText({
      messages: buildMessages({ systemPrompt, history, newMessage: text }),
      config,
    })

    // Two ways a reply is unusable, both regenerated once and then replaced
    // with a short in-character line. Neither can be dropped silently --
    // someone is waiting for an answer.
    //
    // Too long: the token budget used to enforce this by itself -- a reply
    //   could not exceed 220 tokens because 220 was all it was given. That
    //   stopped being true when the budget had to grow to let a reasoning
    //   model think (src/constants/chatBudget.js). The length rule did not
    //   go away with it; it moved here, where it is about the REPLY rather
    //   than about the reply plus whatever the model thought first.
    const unusable = (t) => trippedBannedWord(t) !== null || leaksReasoning(t) || tooLongForChat(t)

    if (unusable(reply)) {
      const why = trippedBannedWord(reply)
        ? 'used a forbidden word'
        : leaksReasoning(reply)
          ? 'showed your own reasoning instead of speaking as the driver'
          : `ran to ${reply.trim().length} characters when the limit is ${CHAT_REPLY_MAX_CHARS}`
      console.warn(`[driverChat] retrying — reply ${why}`)
      reply = await chatText({
        messages: buildMessages({
          systemPrompt: `${systemPrompt}\n\nYour last reply ${why}. Reply again as the driver, in character, one to three sentences only.`,
          history,
          newMessage: text,
        }),
        config,
      })
      if (unusable(reply)) reply = FALLBACK_REPLY
    }
  } catch (err) {
    console.error(`[driverChat] model call failed: ${err.message}`)
    // The provider ran out before the app's own budget did. Saying the
    // driver cannot be reached would be a sentence about a person who is
    // standing right there; what happened is that the account is out of
    // requests, which is a different fact with a different answer.
    if (err.quotaExhausted) {
      throw new AppError('CHAT_DAILY_LIMIT', {
        message: "Provayder bugungi so'rovlar limitini tugatdi. Ertaga yangilanadi."
          + (err.providerMessage ? ` (${err.providerMessage})` : ''),
        source: 'provider',
      })
    }
    throw new AppError('DRIVER_UNREACHABLE')
  }

  // Written now, shown later. A second question sent during the wait
  // replaces the pending answer in the same slot rather than stacking a
  // second reply behind it -- which is what a person does when they read
  // both messages at the next stop.
  //
  // Inside a transaction that locks the conversation first. The model call
  // above takes seconds, so two sends in that window both used to find no
  // pending reply and both fell through to a plain insert -- two answers
  // stacked, the exact thing replacePendingReply exists to prevent. The
  // lock makes the second send see the first one's pending reply.
  await withTransaction(async (client) => {
    await repo.lockConversation(client, conversationId)
    const replaced = await repo.replacePendingReply(conversationId, reply.trim(), client)
    if (!replaced) {
      const delaySec = driverReplyDelaySec(context.driver.dutyStatus)
      await repo.addMessage(conversationId, 'driver', reply.trim(), { delaySec, client })
    }
  })

  // The driver's message is deliberately NOT returned. Handing the caller
  // something it is not allowed to show yet is how a delay becomes a bug.
  return { dispatcherMessage, awaitingReply: true }
}

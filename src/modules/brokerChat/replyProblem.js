// What is wrong with a broker reply, as one answer: the live service and the
// scripts (chat-eval, chat-scenarios) ask this same function, so a check
// added here is a check everywhere -- there is no second copy to drift.
//
// null when the reply is fine; otherwise { why, hint, unusable }:
//   why      what to say went wrong ("Your last reply <why>.")
//   hint     extra instruction for the regeneration (may be empty)
//   unusable true when no regeneration can be shown as it stands (banned
//            word, leaked reasoning, too long): the service falls back to a
//            holding line. A content problem is kept and only logged.

import { trippedBannedWord, leaksReasoning } from './brokerChat.prompt.js'
import { tooLongForChat, CHAT_REPLY_MAX_CHARS } from '../../constants/chatBudget.js'
import { ignoresUnreachable } from '../../lib/cannotMake.js'
import { lumperPayerWrong } from './termsTalk.js'

export function brokerReplyProblem(reply, { truck } = {}) {
  if (trippedBannedWord(reply) !== null) return { why: 'used a forbidden word', hint: '', unusable: true }
  if (leaksReasoning(reply)) return { why: 'showed your own reasoning instead of speaking as the broker', hint: '', unusable: true }
  if (tooLongForChat(reply)) {
    return { why: `ran to ${reply.trim().length} characters when the limit is ${CHAT_REPLY_MAX_CHARS}`, hint: '', unusable: true }
  }
  // The carrier's truck cannot reach the pickup in time (computed from the
  // city they named and the clock) and the reply never says so.
  if (ignoresUnreachable(reply, truck, { broker: true })) {
    return {
      why: 'did not tell the carrier their truck gets there after your pickup',
      hint: ' The facts above say their truck gets there after your pickup: say so plainly, with the miles, then ask one thing.',
      unusable: false,
    }
  }
  // The terms say the broker pays the lumper against a receipt (the same
  // line the prompt carries); the reply puts it on someone else.
  if (lumperPayerWrong(reply)) {
    return {
      why: 'said someone other than you pays the lumper',
      hint: ' YOUR TERMS say: Lumper: paid by the broker against a receipt. Say that.',
      unusable: false,
    }
  }
  return null
}

// The system prompt for the one regeneration.
export function brokerRetryPrompt(systemPrompt, problem) {
  return `${systemPrompt}

Your last reply ${problem.why}.${problem.hint} Reply again as the broker, in character, one to three sentences only.`
}

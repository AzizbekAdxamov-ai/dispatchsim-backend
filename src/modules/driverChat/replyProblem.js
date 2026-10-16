// What is wrong with a driver reply, as one answer: the live service and the
// scripts (chat-eval, chat-scenarios) ask this same function, so a check
// added here is a check everywhere -- there is no second copy to drift.
//
// null when the reply is fine; otherwise { why, hint, unusable }:
//   why      what to say went wrong ("Your last reply <why>.")
//   hint     extra instruction for the regeneration (may be empty)
//   unusable true when no regeneration can be shown as it stands (banned
//            word, leaked reasoning, too long): the service falls back to a
//            holding line. A content problem is kept and only logged.
// `text` is the dispatcher's line, for checks that depend on what was asked.

import { trippedBannedWord, leaksReasoning } from './driverChat.prompt.js'
import { tooLongForChat, CHAT_REPLY_MAX_CHARS } from '../../constants/chatBudget.js'
import { ignoresUnreachable } from '../../lib/cannotMake.js'
import { refusesWithoutReason } from '../../lib/refusalReason.js'

export function driverReplyProblem(reply, { offer, text } = {}) {
  if (trippedBannedWord(reply) !== null) return { why: 'used a forbidden word', hint: '', unusable: true }
  if (leaksReasoning(reply)) return { why: 'showed your own reasoning instead of speaking as the driver', hint: '', unusable: true }
  if (tooLongForChat(reply)) {
    return { why: `ran to ${reply.trim().length} characters when the limit is ${CHAT_REPLY_MAX_CHARS}`, hint: '', unusable: true }
  }
  // The facts say she cannot make the pickup (computed from her position
  // and the clock) and the reply never says so.
  if (ignoresUnreachable(reply, offer)) {
    return {
      why: 'did not say you cannot make that pickup',
      hint: ' The facts above say you cannot make that pickup: say so plainly, with the miles, and ask for a later pickup time.',
      unusable: false,
    }
  }
  // She was asked to do something and said no without saying why.
  if (refusesWithoutReason(reply, text)) {
    return {
      why: 'turned it down without a reason',
      hint: ' Give the reason in a few words from what is written above (the miles, your hours, the rule, the empty run) -- never a bare no.',
      unusable: false,
    }
  }
  return null
}

// The system prompt for the one regeneration.
export function driverRetryPrompt(systemPrompt, problem) {
  return `${systemPrompt}

Your last reply ${problem.why}.${problem.hint} Reply again as the driver, in character, one to three sentences only.`
}

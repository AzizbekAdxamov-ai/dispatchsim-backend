// What is wrong with a driver reply, as one answer: the live service and the
// scripts (chat-eval, chat-scenarios) ask this same function, so a check
// added here is a check everywhere -- there is no second copy to drift.
//
// null when the reply is fine; otherwise { why, hint, unusable }:
//   why      what to say went wrong ("Your last reply <why>.")
//   hint     extra instruction for the regeneration (may be empty)
//   unusable true when no regeneration can be shown as it stands (banned
//            word, leaked reasoning, too long, an unreachable pickup the
//            reply still does not own up to): the service shows safeReply,
//            or a holding line. A content problem is kept and only logged.
// `text` is the dispatcher's line, for checks that depend on what was asked.

import { trippedBannedWord, leaksReasoning } from './driverChat.prompt.js'
import { tooLongForChat, CHAT_REPLY_MAX_CHARS } from '../../constants/chatBudget.js'
import { ignoresUnreachable, milesOff, cannotMakeLine } from '../../lib/cannotMake.js'
import { refusesWithoutReason } from '../../lib/refusalReason.js'
import { hosReplyProblem } from '../../lib/hosPressure.js'

export function driverReplyProblem(reply, { offer, text } = {}) {
  if (trippedBannedWord(reply) !== null) return { why: 'used a forbidden word', hint: '', unusable: true }
  if (leaksReasoning(reply)) return { why: 'showed your own reasoning instead of speaking as the driver', hint: '', unusable: true }
  if (tooLongForChat(reply)) {
    return { why: `ran to ${reply.trim().length} characters when the limit is ${CHAT_REPLY_MAX_CHARS}`, hint: '', unusable: true }
  }
  // A driving/log violation needs a plain no. A statement of remaining
  // hours, or "Copy that", leaves the dangerous request standing.
  const hos = hosReplyProblem(reply, text)
  if (hos) return hos
  // The model may say "can't make it" but change the computed distance.
  // Correct it on retry; never show the wrong number after a second miss.
  if (milesOff(reply, offer)) {
    const miles = offer.miles.toLocaleString('en-US')
    const safeReply = offer.makesIt === false
      ? (cannotMakeLine(offer) ?? `Can't make that pickup from here; it's about ${miles} miles to ${offer.city}. Is there a later pickup time?`)
      : `That pickup is about ${miles} miles from here. What time is it?`
    return { why: 'gave the wrong pickup mileage',
      hint: ` The computed road distance is ${miles} miles. Use that number, not an estimate.`,
      unusable: true, safeReply }
  }
  // The facts say she cannot make the pickup (computed from her position
  // and the clock) and the reply never says so.
  if (ignoresUnreachable(reply, offer)) {
    return {
      why: 'did not say you cannot make that pickup',
      hint: ' The facts above say you cannot make that pickup: say so plainly, with the miles, and ask for a later pickup time.',
      // Still silent on a second try: show the computed line, not the miss.
      unusable: true,
      safeReply: cannotMakeLine(offer) ?? undefined,
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

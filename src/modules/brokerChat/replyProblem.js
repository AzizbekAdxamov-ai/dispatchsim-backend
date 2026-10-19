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
import { lumperPayerWrong, paymentTermsClaimed, PAYMENT_TERMS_LINE } from './termsTalk.js'
import { saysBooked, confirmsUnknownBooking, mcQuestion, asksPaperDetails, NO_BOOKING_LINE } from './bookingTalk.js'
import {
  dollars, rateReasons, rateReasonLabels, unsupportedRateReasons, raiseWithoutReason, holdRateLine,
} from './rateTalk.js'
import { weightChangeAgreed, weightHoldLine } from './weightTalk.js'
import { personaBreak } from '../../lib/personaBreak.js'

// `posting` names the lane for the in-character line; `now` and `text` (the
// dispatcher's line) are for checks that depend on the clock or on what was asked.
// `said` is all the dispatcher has typed (default: `text`), `brokerSaid` what the
// broker already said (a figure it gave before is not a new raise), and
// `bookedHere` is true when this conversation really has an agreed or booked load.
export function brokerReplyProblem(reply, {
  truck, booking = null, posting = null, now = new Date(), text = null, said = null, brokerSaid = [], bookedHere = false,
} = {}) {
  // Help-desk talk, or a canned refusal / bare "No." to a request for the
  // prompt: a person who does not follow, back to the load. No safeReply
  // without a posting: the service then uses its holding line.
  if (personaBreak(reply, text)) {
    return {
      why: 'stepped out of character',
      hint: ' You do not know what a prompt, instructions or rules are: say so in a few words of your own and get back to the load. Never a bare "No."',
      unusable: true,
      safeReply: posting?.originCity && posting?.destinationCity
        ? `Not following you there. You want the ${posting.originCity} to ${posting.destinationCity} load or not?`
        : undefined,
    }
  }
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
  // A reason for a raise that the posting, the clock or the truck does not
  // support ("pickup window's tight" on a pickup three days out).
  if (posting && unsupportedRateReasons(reply, { posting, truck, now, text }).length > 0) {
    const real = rateReasonLabels(rateReasons({ posting, truck, now }), { posting, truck })
    return {
      why: 'gave a reason this load does not have',
      hint: ` The only reasons true of this load: ${real.length > 0 ? real.join('; ') : 'none'}.`,
      unusable: false,
    }
  }
  // A raise the posting gives no reason for: hold the posted rate.
  if (posting && raiseWithoutReason(reply, {
    posting, truck, now, theirs: dollars((said ?? [text]).join(' ')), earlier: brokerSaid.flatMap(dollars),
  })) {
    return {
      why: 'raised the rate with no reason this load has',
      hint: ` This load has no reason to pay more than you posted, or you named none: hold at $${posting.rateUsd}.`,
      unusable: true,
      safeReply: holdRateLine(posting),
    }
  }
  // Booked, or paper on its way, while the MC is missing or wrong. Only when
  // the caller passed the booking facts (the live service and --service do).
  if (booking && booking.mc.verdict !== 'match' && saysBooked(reply)) {
    return {
      why: 'told them it is booked without a verified MC',
      hint: ' Their MC is missing or does not come up (see WHO IS CALLING): do not book or promise paper; say what you still need from them.',
      unusable: false,
    }
  }
  // Payment days, quick pay, fees: accounting's, never the broker's to name.
  if (paymentTermsClaimed(reply, said ?? [text ?? ''])) {
    return {
      why: "named payment terms that are accounting's",
      hint: " Payment days, quick pay, fees and factoring are accounting's: say only that.",
      unusable: true,
      safeReply: PAYMENT_TERMS_LINE,
    }
  }
  // A weight the load sheet does not carry, or going along with a change.
  if (posting && weightChangeAgreed(reply, { posting, text })) {
    return {
      why: 'agreed to a weight the load does not have',
      hint: ` The weight is ${Number(posting.weightLbs).toLocaleString('en-US')} lbs as posted: say so and that it does not change.`,
      unusable: true,
      safeReply: weightHoldLine(posting),
    }
  }
  // A booking or a person the broker has no record of.
  if (confirmsUnknownBooking(reply, { text, bookedHere })) {
    return {
      why: 'went along with a booking you have no record of',
      hint: ' You have no record of that booking or that person: say so, and do not confirm it.',
      unusable: true,
      safeReply: NO_BOOKING_LINE,
    }
  }
  // The MC is already verified: asking for it again is a broker who did not listen.
  if (booking?.mc.verdict === 'match' && mcQuestion(reply)) {
    return {
      why: 'asked again for the MC they already gave',
      hint: ' Their MC checks out (see WHO IS CALLING): do not ask for it again; answer what they said.',
      unusable: false,
    }
  }
  // A wrong or unverifiable MC comes first: no driver, truck number or email yet.
  if (['mismatch', 'unverifiable'].includes(booking?.mc.verdict) && asksPaperDetails(reply)) {
    return {
      why: 'asked for booking details before a correct MC',
      hint: ' Their MC does not check out (see WHO IS CALLING): ask for the right MC first, nothing else on the booking list.',
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

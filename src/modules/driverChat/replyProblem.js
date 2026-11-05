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
// `load` is the load being talked about (may be null), for in-character lines.

import { trippedBannedWord, leaksReasoning } from './driverChat.prompt.js'
import { tooLongForChat, CHAT_REPLY_MAX_CHARS } from '../../constants/chatBudget.js'
import { ignoresUnreachable, milesOff, cannotMakeLine, cannotMakeWithoutMiles, saysCannotMake } from '../../lib/cannotMake.js'
import { refusesWithoutReason } from '../../lib/refusalReason.js'
import { hosReplyProblem, hosPressureKind } from '../../lib/hosPressure.js'
import { personaBreak, noWayBack } from '../../lib/personaBreak.js'
import { willAcceptWork } from '../../constants/driverPay.js'
import { asciiPunct } from '../../lib/plainText.js'
import { driverReplyTask } from './driverConversation.js'
import { inventsEnvironment, NO_ENVIRONMENT_LINE } from '../../lib/environmentClaims.js'
import { latenessProblem, latenessLine } from '../../lib/lateness.js'
import { clockDateTime } from '../../constants/appClock.js'

function unsupportedHealthClaim(reply, driver, text, history) {
  const answer = asciiPunct(reply)
  const bio = asciiPunct(driver?.bio ?? '')
  const name = asciiPunct(driver?.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const firstName = name.split(/\s+/)[0]
  const subject = `(?:he|she|driver${name ? `|${name}|${firstName}` : ''})`
  const task = driverReplyTask({ text, history })
  const healthContext = ['personal-health', 'health-help'].includes(task) || /\b(?:drugs?|alcohol|sober)\b/i.test(answer)
  const hygiene = /\bclean(?:[-\s]+shaven|\s+(?:after|from)\s+(?:a\s+)?(?:shower|bath|wash))\b|\b(?:washed|washing)\s+my\s+hands\b/i.test(answer)
  const claims = ['clean', 'sober'].filter((word) => word !== 'clean' || (healthContext && !hygiene)).map((word) => [
    new RegExp(`\\bI(?:(?:'m| am| stay| remain)\\s+${word}\\b(?![-\\s]+(?:shav\\w*|ing\\b|the\\b|my\\b|out\\b|up\\b))|(?:'ve| have)\\s+been\\s+${word}\\b)`, 'i'),
    new RegExp(`\\b${subject}\\s+(?:is|has been|stays|remains)\\s+${word}\\b(?![-\\s]+(?:shav\\w*|ing\\b|the\\b|out\\b|up\\b))`, 'i'),
  ])
  for (const substance of ['drugs?', 'alcohol']) claims.push([
    new RegExp(`\\b(?:no\\s+(?:drugs?\\s+or\\s+)?${substance}\\s+on\\s+my\\s+end|I(?:(?:'ve| have)\\s+never\\s+used|\\s+never\\s+(?:used?|drank|drink)|\\s+(?:don't|do not)\\s+(?:use|drink))\\s+(?:drugs?\\s+or\\s+)?${substance})\\b`, 'i'),
    new RegExp(`\\b${subject}\\s+(?:never\\s+(?:used?|drank|drinks?)|(?:doesn't|does not)\\s+(?:use|drink))\\s+${substance}\\b`, 'i'),
  ])
  return claims.some(([claim, grounded]) => claim.test(answer) && !grounded.test(bio))
}

// These are driver-only conversational failures, not forbidden topics. Work
// questions and real requests for help must retain their substantive answer.
function conversationProblem(reply, text, driver, history) {
  const line = asciiPunct(text ?? '')
  const answer = asciiPunct(reply)
  const workAsk = /\b(?:truck|trailer|hours?|hos|eld|fuel|pay|settlement|pickup|delivery|eta|miles?|load|where|location)\b/i.test(line)
  const problem = (why, hint, safeReply) => ({ why, hint, safeReply, unusable: true })
  if (unsupportedHealthClaim(reply, driver, text, history)) {
    return problem('invented personal sobriety or substance-use history',
      ' Your profile does not establish that personal health claim. Do not repeat it or treat a dispatcher allegation as your medical history. Keep personal history private, while addressing any real safety question seriously.',
      "I'd rather keep my personal history private.")
  }
  if (/\b(?:anything(?:\s+else)?\s+(?:I\s+can\s+help|work-related\s+you\s+need)|(?:how|what)\s+can\s+I\s+help\s+(?:you\s+)?with|let\s+me\s+know\s+if\s+(?:you\s+need|I\s+can\s+help))\b/i.test(answer)) {
    return problem('offered generic help instead of answering as a driver',
      ' Answer this message in your own voice. Do not add a customer-service offer or an automatic work redirect.',
      "What do you mean?")
  }
  const medicalHelp = /\b(?:help|advice|assistance|medical|emergency|counsel\w*|overdos\w*|withdrawal|addict\w*|drunk|impaired|intoxicat\w*|took|taken|used|using)\b/i.test(line)
  if (!medicalHelp && /\b(?:medical\s+professional|counselor|counsellor|seek\s+(?:medical|professional)\s+help)\b/i.test(answer)) {
    return problem('gave unsolicited clinical advice during casual conversation',
      ' No medical help was requested. Respond to the actual personal comment briefly, without inventing medical or substance-use history.',
      "Not sure what you're getting at. What did you mean?")
  }
  const social = /^\s*(?:bro|hey|hi|hello|yo|wass?up|what'?s\s+up)[.!?\s]*$/i.test(line)
    || /\b(?:r\s*u|are\s+you|you\s+a)\s+(?:a\s+)?(?:bot|robot|ai)\b/i.test(line)
  if (social && !workAsk) {
    const knownTruck = driver?.truckId && answer.toLowerCase().includes(String(driver.truckId).toLowerCase())
    if (knownTruck || /\b\d+\s*(?:hours?\s+(?:left|remaining)|[- ]?foot\s+(?:dry|trailer|reefer))\b/i.test(answer)) {
      return problem('recited unasked equipment or hours during small talk',
        ' Keep this social answer short. No truck identifier, trailer specification or remaining-hours report was requested.',
        /\b(?:bot|robot|ai)\b/i.test(line) ? "No, it's me." : 'Hey, what\'s up?')
    }
  }
  // Only standalone arithmetic/trivia. Never classify a dispatch calculation
  // by the presence of digits alone, or attempt to compute a result here.
  const randomSum = !workAsk && /^\s*[\d\s,+*/().=?-]+(?:\s*(?:can\s+(?:you|u)\s+gues\w*|what\s+is\s+it))?\s*[?!.]*\s*$/i.test(line)
    && /\d\s*[-+*/]\s*\d/.test(line)
  const basicNumber = driverReplyTask({ text, history }) === 'number-banter' && !randomSum
  if ((randomSum && /^\s*(?:the\s+(?:answer|result)\s+is\s*)?[-+]?\d[\d,.]*\s*[.!]?\s*$/i.test(answer))
    // "comes right after 1" slipped the bare "comes after" on the live
    // retry of 2026-10-23, so adverbs between the verb and the direction
    // are allowed through in a bounded way.
    || (basicNumber && /\b(?:integer|comes\s+(?:\w+\s+){0,2}(?:after|before))\b/i.test(answer))) {
    return problem('switched into a calculator or encyclopedia for unrelated banter',
      ' Treat the unrelated number question as banter. Do not guess an exact result or give a textbook definition; keep your own voice.',
      randomSum ? "I'd need a calculator for that one." : "What's with the number quiz?")
  }
  return null
}

// What she says when asked for "the prompt": a person who does not know what
// that means, back on the lane when there is one.
function notFollowingLine(load) {
  return load?.originCity && load?.destinationCity
    ? `No idea what that means, boss. I'm on the ${load.originCity} to ${load.destinationCity} load, what do you need?`
    : 'No idea what that means, boss. You got a load for me or what?'
}

/// Words from the system's own status notes. A driver says "not sure when my
// ten's up", never "rest end time isn't verified"; bare "verified" stays legal
// ("I verified the seal").
const LEAKED_STATUS_RE = /\b(?:(?:is|isn't|is\s+not|not)\s+verified|unverified|feasibility|rest\s+end\s+time)\b/i
const REST_UNKNOWN_LINE = "Not sure when my ten's up, so I can't give you a solid time yet."

// The computed "cannot make it" line; without a pickup time to quote, a
// shorter one that still names the miles and the city.
const unreachableLine = (offer, miles) => cannotMakeLine(offer)
  ?? `Can't make that pickup from here; it's about ${miles} miles to ${offer.city}. Is there a later pickup time?`

// A resting driver's remaining HOS is not the end of her current ten. The
// model has twice supplied a clock time anyway (including the live Great
// Falls exchange), then built a false legal verdict on that invented time.
// Limit this guard to a direct rest/arrival question and a reply that gives
// a clock or a definite pickup verdict; ordinary chat is unaffected.
function inventedRestEta(reply, text, offer, driver, load = null) {
  if (!offer?.restEndUnknown && driver?.dutyStatus !== 'resting') return false
  // A computed refusal (even a rest ending now cannot reach it) is not an invented ETA.
  if (offer?.makesIt === false && saysCannotMake(reply)) return false
  // Her own load's recorded ETA is a fact she was given, not a guess (ED02).
  if (!offer && quotesRecordedEta(reply, load)) return false
  const asked = /\b(?:rest\s+(?:end|finish)|(?:end|finish)\s+(?:my|your|the)?\s*rest|eta|arrival|arrive|reach|make\s+(?:it|the\s+pickup)|roll\s+into|(?:be|get)\s+there)\b/i.test(text ?? '')
  if (!asked) return false
  return /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b|\b(?:can|cannot|can't|will|won't|could|would|should)\s+(?:\w+\s+){0,2}(?:make\s+(?:it|the\s+pickup)|reach\b|get\s+to\b|be\s+there\b|get\s+there\b)|\b(?:before|after)\s+(?:the\s+)?pickup\b|\b(?:expect|likely|probably|should|will|can|could|would)\b.{0,30}\b(?:tomorrow|tonight|morning|afternoon|evening|dawn|dusk|lunch)\b|\b(?:by|before|after|around)\s+(?:tomorrow\s+)?(?:morning|afternoon|evening|dawn|dusk|lunch)\b|^\s*(?:yes|yeah|yep|sure|I can)\b/i.test(reply)
}

// The load's recorded ETA, as the prompt states it ("You are due into ...
// around Fri, Nov 6, 9:45 AM", driverChat.prompt.js). A reply whose every
// clock time is that one quotes a fact. ED02 (eval 2026-11-02, both models):
// "whats ur eta" was answered with this time and regenerated as invented.
function recordedEtaClock(load) {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M\b/.exec(clockDateTime(load?.etaAt) ?? '')
  return m ? { hour: Number(m[1]), minute: Number(m[2]), half: m[3] } : null
}
function quotesRecordedEta(reply, load) {
  const eta = recordedEtaClock(load)
  if (!eta) return false
  const times = [...asciiPunct(String(reply ?? '')).matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/gi)]
  return times.length > 0 && times.every((t) => Number(t[1]) === eta.hour
    && t[3].toUpperCase() === eta.half && (t[2] == null || Number(t[2]) === eta.minute))
}

// Offer checks answer the offer. A turn about HOS, a bot question, small
// talk or the weather is not a turn about that pickup: live 2026-11-03 #116
// ("skip ur 10 and roll now") and #121 ("r u a bot lol") were both replaced
// by the Atlanta "can't make" line. With no dispatcher text (older callers),
// the reply is still checked against the offer.
function talksAboutOffer(text, offer) {
  if (text == null) return true
  if (hosPressureKind(text) !== null) return false
  const line = asciiPunct(String(text))
  const city = offer?.city ? String(offer.city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null
  if (city && new RegExp(`\\b${city}\\b`, 'i').test(line)) return true
  return /\b(?:pu|p\/u|pickup|pick\s*up|loads?|eta|arriv\w*|make\s+it|get\s+there|be\s+there|how\s+far|miles?|earliest|later|reschedul\w*|appt|appointment|take\s+(?:it|that|this))\b/i.test(line)
}

// The offer block is intentionally hidden from a driver who refuses work
// or has left. A model can still use the dispatcher's words to negotiate
// an ETA; keep the payroll decision authoritative on that path too.
function ignoresWorkStance(reply, text, standing) {
  if (!standing?.stage || willAcceptWork(standing.stage)) return false
  // "What load am I on?" and "What time is the pickup?" ask for facts,
  // not a commitment. Only a prospective assignment or arrival ask needs
  // the payroll refusal in this reply.
  const asksAboutWork = /\b(?:can|could|will|would|should)\s+you(?:\s+\w+){0,2}\s+(?:take|accept|book|run|haul|reach|make|be|get|cover)\b|\bavailable\s+for\b.{0,80}\b(?:run|haul|freight|load|pickup)\b|\b(?:what\s+time|when|earliest|eta|arrival)\b.{0,80}\b(?:arriv\w*|be\s+there|get\s+there|reach|roll\s+into)\b|\b(?:sending|assigning|dispatching)\s+you\b|\b(?:new|next|another)\s+load\b|\bloads?\s+next\b|\bgot\s+(?:a|an|the|another)\b.{0,40}\bloads?\b|\btake\s+the\b.{0,60}\bloads?\b|\b(?:what'?s|whats|wats)\s+(?:ur|your)\s+eta\b/i.test(text ?? '')
  if (!asksAboutWork) return false
  const refuses = /\b(?:not\s+taking|won't\s+take|cannot\s+take|can't\s+take|do\s+not\s+run|don't\s+run|no\s+longer\s+(?:tak(?:e|ing)|run(?:ning)?|driv(?:e|ing)|work(?:ing)?)|left\s+(?:the\s+company|your\s+roster)|quit|moved\s+on)\b/i.test(reply)
  const stillGivesEta = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b|\b(?:can|will|could|would|should)\s+(?:\w+\s+){0,2}(?:take\b|accept\b|make\b|reach\b|get\b|be\b|arrive\b|cover\b)|\b(?:expect|likely|probably)\b.{0,30}\b(?:tomorrow|tonight|morning|afternoon|evening|dawn|dusk)\b|^\s*(?:yes|yeah|yep|sure|I can)\b/i.test(reply)
  return !refuses || stillGivesEta
}

// A pickup calculation must not become a promise about the loaded leg.
// Quoting the delivery appointment is fine; committing to arrival is not.
function deliveryCommitment(reply, text, offer) {
  if (!offer || offer.deliveryVerified !== false) return false
  const deliveryAsk = /\b(?:delivery|deliver|receiver|both\s+appointments|both\s+times)\b/i.test(text ?? '')
  const promises = (clause) => /\b(?:I|we)(?:\s+(?:can(?!['\u2019]t)|will|could|should)|['\u2019]ll)\s+(?!not\b)(?:\w+\s+){0,3}(?:deliver\b|(?:make|hit|meet|reach|arrive|get|be)\b[^.!?]{0,100}\b(?:delivery|receiver|both\b|make\s+them))|\b(?:delivery|receiver)(?:\s+is)?\s+(?:no\s+problem|guaranteed|confirmed)(?!\s+(?:for|at)\b)\b|\bboth(?:\s+appointments)?\s+(?:work|are\s+(?:fine|doable))\b/i.test(clause)
    || (deliveryAsk && /^\s*(?:yes|yeah|yep|sure|absolutely|no problem)[.!\s]*$/i.test(reply))
    || (deliveryAsk && /\b(?:I|we)\s+can\s+(?:do\s+that|make\s+it)\b/i.test(clause))
    || (deliveryAsk && /\b(?:I|we)(?:\s+(?:can(?!['\u2019]t)|will|could|should)|['\u2019]ll)\s+(?:be|get|arrive)\s+there\b/i.test(clause))
  // Each commitment needs its own qualification; a separate cautious
  // sentence must not excuse an unconditional delivery promise.
  return reply.split(/[.!?;]/).some((clause) => {
    const qualified = /\b(?:delivery|deliver|receiver|both)\b/i.test(clause)
      && /\b(?:loading|duty|rest)\b/i.test(clause)
      && /\b(?:if|provided|assuming|depends|depending|subject\s+to|conditional|until|unknown|unverified|can't\s+confirm|cannot\s+confirm|not\s+(?:yet\s+)?confirmed|not\s+sure|need\s+to\s+(?:verify|confirm))\b/i.test(clause)
    return promises(clause) && (offer.deliveryImpossible || !qualified)
  })
}

export function driverReplyProblem(reply, { offer, text, load = null, driver = null, standing = null, history = [] } = {}) {
  // HOS is a safety rule and wins when both fire. A correct HOS refusal
  // makes hosReplyProblem return null, so persona is skipped whenever the ask
  // itself is an HOS ask (hosPressureKind), not only when the reply is wrong.
  // The HOS result is still returned below, after the banned-word checks.
  const hos = hosReplyProblem(reply, text)
  const hosAsk = hosPressureKind(text) !== null
  if (!hos && !hosAsk && personaBreak(reply, text)) {
    return {
      why: 'stepped out of character',
      hint: ' You do not know what a prompt, instructions or rules are: say so in a few words of your own and get back to the load. Never a bare "No."',
      unusable: true,
      safeReply: notFollowingLine(load),
    }
  }
  // Told "I don't know what you mean" and nothing else: no way back to work.
  if (!hos && !hosAsk && noWayBack(reply, text, load)) {
    return {
      why: 'did not get back to work',
      hint: ' Say in a few words that you do not know what that means, then turn back to the load or ask if they have one.',
      unusable: true,
      safeReply: notFollowingLine(load),
    }
  }
  if (trippedBannedWord(reply) !== null) return { why: 'used a forbidden word', hint: '', unusable: true }
  if (leaksReasoning(reply)) return { why: 'showed your own reasoning instead of speaking as the driver', hint: '', unusable: true }
  if (tooLongForChat(reply)) {
    return { why: `ran to ${reply.trim().length} characters when the limit is ${CHAT_REPLY_MAX_CHARS}`, hint: '', unusable: true }
  }
  // A driving/log violation needs a plain no. A statement of remaining
  // hours, or "Copy that", leaves the dangerous request standing.
  if (hos) return hos
  if (LEAKED_STATUS_RE.test(reply)) {
    const place = offer?.state ? `${offer.city}, ${offer.state}` : offer?.city
    const miles = offer?.miles == null ? '' : `I'm about ${offer.miles.toLocaleString('en-US')} road miles from ${place}. `
    const restUnknown = offer?.restEndUnknown || driver?.dutyStatus === 'resting'
    return {
      why: 'used system wording instead of a driver\'s words',
      hint: ' Say it the way a driver would, for example "not sure when my ten\'s up"; never mention what is verified, feasibility or a rest end time.',
      unusable: true,
      // Without a rest to talk about the service uses its own holding line.
      safeReply: restUnknown ? `${miles}${REST_UNKNOWN_LINE}` : undefined,
    }
  }
  if (inventsEnvironment(reply)) return {
    why: 'invented weather or traffic information', hint: ' No weather or traffic feed is available. Say what is unknown without guessing conditions.',
    unusable: true, safeReply: NO_ENVIRONMENT_LINE,
  }
  const lateProblem = latenessProblem(reply, { load, text })
  if (lateProblem) return {
    why: lateProblem, hint: ' Compare only the recorded ETA and delivery appointment. Use their exact lateness duration, or say it is unknown.',
    unusable: true, safeReply: latenessLine(load),
  }
  if (ignoresWorkStance(reply, text, standing)) {
    const safeReply = standing.stage === 'quits'
      ? "I'm no longer running loads for your company."
      : "I'm not taking another load until the overdue settlement is paid."
    return {
      why: 'discussed a new load without your work refusal',
      hint: ' You are not taking new work. Say so plainly; do not give an ETA, rest-end time, or promise to reach the pickup.',
      unusable: true,
      safeReply,
    }
  }
  if (inventedRestEta(reply, text, offer, driver, load)) {
    const place = offer?.state ? `${offer.city}, ${offer.state}` : offer?.city
    const miles = offer?.miles == null ? '' : `I'm about ${offer.miles.toLocaleString('en-US')} road miles from ${place}. `
    const recorded = !offer && load?.etaAt && clockDateTime(load.etaAt)
    return {
      why: 'gave an unverified rest end or arrival time',
      hint: recorded
        ? ` Your recorded ETA is ${recorded}. Give that time and nothing else; do not invent a rest end time.`
        : ' Your current rest end time is not recorded. Do not give a clock time, legal ETA, or pickup verdict; correct any earlier guess.',
      unusable: true,
      safeReply: (offer?.makesIt === false ? cannotMakeLine(offer) : null)
        ?? (recorded ? `I'm due into ${load.destinationCity} around ${recorded}.` : null)
        ?? `${miles}${REST_UNKNOWN_LINE}`,
    }
  }
  if (deliveryCommitment(reply, text, offer)) {
    return {
      why: offer.deliveryImpossible ? 'promised an unreachable delivery' : 'promised delivery without verified loading, duty and rest timing',
      hint: ' Pickup feasibility does not verify delivery. State the missing loading, duty and rest details; do not promise both appointments.',
      unusable: true,
      safeReply: offer.deliveryImpossible
        ? "I can't make that delivery appointment; the loaded driving alone takes longer than that window on my clock. Can we get a later delivery?"
        : `${offer.makesIt === true ? 'I can reach the pickup. ' : ''}I can't confirm delivery until the loading time, duty window and rest timing are clear.`,
    }
  }
  // A driver who is not taking work was never shown the offer (prompt hides
  // it): its checks would ask her to discuss a load she has refused.
  const takesWork = !standing?.stage || willAcceptWork(standing.stage)
  const offerTurn = takesWork && talksAboutOffer(text, offer)
  // The model may say "can't make it" but change the computed distance.
  // Correct it on retry; never show the wrong number after a second miss.
  if (takesWork && milesOff(reply, offer)) {
    const miles = offer.miles.toLocaleString('en-US')
    const safeReply = offer.makesIt === false
      ? unreachableLine(offer, miles)
      : `That pickup is about ${miles} miles from here. What time is it?`
    return { why: 'gave the wrong pickup mileage',
      hint: ` The computed road distance is ${miles} miles. Use that number, not an estimate.`,
      unusable: true, safeReply }
  }
  // The facts say she cannot make the pickup (computed from her position
  // and the clock) and the reply never says so.
  if (offerTurn && ignoresUnreachable(reply, offer)) {
    return {
      why: 'did not say you cannot make that pickup',
      hint: ' The facts above say you cannot make that pickup: say so plainly, with the miles, and ask for a later pickup time.',
      // Still silent on a second try: show the computed line, not the miss.
      unusable: true,
      safeReply: cannotMakeLine(offer) ?? undefined,
    }
  }
  // "Can't make it" with no distance: the dispatcher has nothing to plan around.
  if (offerTurn && cannotMakeWithoutMiles(reply, offer)) {
    const miles = offer.miles.toLocaleString('en-US')
    return {
      why: 'did not give the miles to that pickup',
      hint: ` Say you are about ${miles} miles out -- the computed road distance -- and ask for a later pickup time.`,
      unusable: true,
      safeReply: unreachableLine(offer, miles),
    }
  }
  // She was asked to do something and said no without saying why.
  const qualifiedDelivery = offer?.deliveryVerified === false
    && /\b(?:delivery|deliver)\b/i.test(reply)
    && /\b(?:until|depends|depending|provided|assuming|if)\b/i.test(reply)
    && /\b(?:loading|duty|rest)\b/i.test(reply)
  // A refusal grounded in the computed facts IS a reasoned one: the offer
  // says the truck cannot make the pickup and the reply says so too. By
  // the time the shared word list runs, a wrong distance has already been
  // rejected (milesOff above) and a distance-free "can't" has been sent
  // back for its miles (cannotMakeWithoutMiles above), so what survives
  // to this line says cannot-make with the computed distance -- a reason
  // words alone cannot see. The recognition lives here, in the driver
  // layer; the shared regex is not loosened for the broker and eval
  // streams. (Live 2026-10-23: a correct 2,056-mile LA refusal was
  // regenerated as "reasonless" and the retry cost 2,675 tokens.)
  const computedRefusal = offer?.makesIt === false && saysCannotMake(reply)
  if (!qualifiedDelivery && !computedRefusal && refusesWithoutReason(reply, text)) {
    return {
      why: 'turned it down without a reason',
      hint: ' Give the reason in a few words from what is written above (the miles, your hours, the rule, the empty run) -- never a bare no.',
      unusable: false,
    }
  }
  // Style must never hide the operational correction the dispatcher needs.
  if (!hosAsk) return conversationProblem(reply, text, driver, history)
  return null
}

// The system prompt for the one regeneration.
export function driverRetryPrompt(systemPrompt, problem) {
  return `${systemPrompt}

Your last reply ${problem.why}.${problem.hint} Reply again as the driver, in character, one to three sentences only.`
}

// Financial decisions are server facts. The model supplies a voice, never a price.
import { asciiPunct } from '../../lib/plainText.js'
import { ceilingFor } from './ratePolicy.js'
import { rateReasons, REASON_WORDS } from './rateTalk.js'

const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi
const MONEY = '(?:\\$\\s*)?(\\d{1,3}(?:,\\d{3})+|\\d{3,5})(?:\\.00)?(?:\\s*\\$)?'
const OFFER = new RegExp(`\\b(?:need|want|asking for|(?:can|could) (?:you|u)(?: do)?|how about|what about|offer|pay|take (?:it|this|the load) for|run (?:it|this) for|do (?:it|this) for)\\s+${MONEY}(?![\\d.,])`, 'gi')
const ACCEPT_AT = new RegExp(`\\b(?:accept|agree (?:on|to)|take (?:it|this|the load) (?:at|for)|book (?:it|this|the load) (?:at|for)|works? (?:at|for))\\s+${MONEY}(?![\\d.,])`, 'gi')
const AMOUNT_FIRST = new RegExp(`^\\s*${MONEY}\\s*(?:all[- ]?in\\s*)?(?:works(?: for (?:me|us))?|is (?:fine|good)|(?:is )?accepted|(?:is )?agreed)[.!]?\\s*$`, 'i')
const ACCEPT = /^(?:(?:ok(?:ay)?|yes|great|thanks)[,!. ]+)*(?:i(?:'ll| will)|we(?:'ll| will)) take (?:it|this|the load)[.!]?\s*$|^(?:(?:ok(?:ay)?|yes)[,!. ]+)*(?:deal|agreed|book it|let's do it|(?:that|the rate|your rate|your offer) works(?: for (?:me|us))?|sounds good|i accept(?: your (?:rate|offer))?)[.!]?\s*$/i
const HOLD = /\b(?:hold off|on hold|not ready|don't (?:book|send|issue|confirm)|do not (?:book|send|issue|confirm)|not (?:book|confirm|accept)(?:ing|ed)? yet|before (?:we|i) (?:book|confirm)|let me (?:check|confirm|verify)|wait for (?:my|our) confirmation|cancel (?:it|this|the load)|release (?:it|this|the load))\b/i
const WALK = /\b(?:i(?:'ll| will) pass|we(?:'ll| will) pass|pass on (?:it|this)|walk away|find another (?:truck|carrier))\b/i
const MORE = /\b(?:do better|need more|pay more|to{1,2} low|too cheap|more money|bump (?:it|the rate)|add (?:a )?(?:little|litle)(?: bit)?|what(?:'s| is) your best)\b/i
const QUOTED = /["“][^"”]*["”]|'[^'\n]{2,}'/g
const HYPOTHETICAL = /\b(?:if|unless|hypothetically|example|suppose|said|quoted|asks?|asking whether|what if|would you accept)\b/i
const NEGATIVE = /\b(?:not|never|can't|cannot|won't|don't|do not|isn't|is not|haven't)\b/i

// Recipient authorization is checked once, per clause, before every intent branch.
// Mask addresses while splitting so their dots cannot detach a negation or condition.
function authorizedRecipient(src) {
  const addresses = []
  const masked = src.replace(QUOTED, ' ').replace(EMAIL, (email) => {
    addresses.push(email.toLowerCase())
    return `EMAILTOKEN${addresses.length - 1}`
  })
  const authorized = []
  let useOwnEmail = false
  // Check dependencies before splitting coordinated clauses: "after I
  // confirm and approve, send..." is still conditional in its entirety.
  const clauses = masked.split(/(?<=[.!?;])\s+|\n+/).flatMap((sentence) => {
    const pendingApproval = /\b(?:after|when|once|until)\b[^.!?;]{0,80}\b(?:confirm\w*|approv\w*|verif\w*|accept\w*|agree\w*|check\w*)\b/i.test(sentence)
    return pendingApproval ? [] : sentence.split(/\b(?:but|however|and)\b/i)
  })
  for (const clause of clauses) {
    if (NEGATIVE.test(clause) || HYPOTHETICAL.test(clause)) continue
    const own = /^(?:(?:yes|okay|ok)[,.! ]+)?(?:please )?(?:use|send (?:it|the (?:rate )?confirmation|the rate con) to) (?:my|our) (?:(?:saved|company|carrier|account|login) )?e-?mail[.!\s]*$/i.test(clause.trim())
    if (own) useOwnEmail = true
    const tokens = [...clause.matchAll(/EMAILTOKEN(\d+)/g)]
    if (tokens.length !== 1) continue
    const emailOnly = clause.replace(/EMAILTOKEN\d+/, '').replace(/[.!\s]/g, '') === ''
    const instruction = /\b(?:my|our) (?:(?:company|carrier|contact|dispatch) )?e-?mail\s*(?:is|:)?\s+EMAILTOKEN\d+/i.test(clause)
      || /\b(?:send|email)\b[^.!?]{0,65}\bto\s+EMAILTOKEN\d+/i.test(clause)
      || /\b(?:use|recipient(?: is|:)?)\s+EMAILTOKEN\d+/i.test(clause)
    const question = /\?/.test(clause) && !/\b(?:send|email)\b[^.!?]{0,65}\bto\s+EMAILTOKEN\d+/i.test(clause)
    if ((emailOnly || instruction) && !question) authorized.push(addresses[Number(tokens[0][1])])
  }
  const emails = [...new Set(authorized)]
  return emails.length > 1 ? { emails: [], useOwnEmail: false } : { emails, useOwnEmail }
}

export function chatIntent(raw) {
  const src = asciiPunct(String(raw ?? ''))
  if (HOLD.test(src) || /^\s*(?:cancel|stop|hold|wait)[.!]?\s*$/i.test(src)
    || /\b(?:reject|decline) (?:your |the )?(?:rate|offer|load)\b/i.test(src)) return { kind: 'hold' }
  const { emails, useOwnEmail } = authorizedRecipient(src)
  // Quotes, negated intentions and conditional examples are never a handshake.
  const clauses = src.replace(QUOTED, ' ').replace(EMAIL, ' ').split(/[;!?\n]|\.(?!\d)/)
  const amounts = []
  let acceptsAmount = false
  for (const clause of clauses) {
    if (HYPOTHETICAL.test(clause) || NEGATIVE.test(clause)) continue
    // An accessorial charge is not the load's linehaul. A mixed financial
    // sentence is clarified rather than guessing which amount is the deal.
    if (/\b(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist|accessorial|per hour|\/hr)\b/i.test(clause)) continue
    for (const pattern of [OFFER, ACCEPT_AT]) {
      for (const m of clause.matchAll(pattern)) {
        const tail = clause.slice(m.index + m[0].length)
        if (/^\s*(?:[-/]\s*\d|(?:lbs?|pounds?|miles?|mi|ft|feet|gal|hours?|hrs?|per|\/|%|am|pm)\b)/i.test(tail)) continue
        amounts.push(Number(m[1].replaceAll(',', '')))
        if (pattern === ACCEPT_AT) acceptsAmount = true
      }
    }
    const first = AMOUNT_FIRST.exec(clause)
    if (first) { amounts.push(Number(first[1].replaceAll(',', ''))); acceptsAmount = true }
  }
  const unique = [...new Set(amounts)]
  if (unique.length > 0 && new Set([...src.replace(EMAIL, '').matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)/g)].map((m) => m[1])).size > 1) return { kind: 'ambiguous' }
  if (unique.length === 1) return { kind: acceptsAmount ? 'accept_amount' : 'offer', rateUsd: unique[0], emails, useOwnEmail }
  if (unique.length > 1) return { kind: 'ambiguous' }
  // Permit an explicit acceptance followed by an email instruction, but no conditional price.
  const acceptance = src.split(/(?<=[.!])\s+/)[0]
  if (!NEGATIVE.test(acceptance) && !HYPOTHETICAL.test(acceptance) && ACCEPT.test(acceptance)) return { kind: 'accept', emails, useOwnEmail }
  if (emails.length === 1 || useOwnEmail) return { kind: 'email', emails, useOwnEmail }
  if (WALK.test(src)) return { kind: 'walk' }
  if (MORE.test(src)) return { kind: 'push' }
  return { kind: 'talk' }
}

const money = (n) => `$${Number(n).toLocaleString('en-US')}`
// Sharing a truck/driver or asking a price is not a request to book.
// Use the same intent at the prompt and reply boundary so MC cannot gate haggling.
export function bookingTurn(text, decision = null) {
  const intent = decision?.intent ?? chatIntent(text)
  if (intent.kind === 'accept') return true
  if (['offer', 'accept_amount'].includes(intent.kind)) return decision ? decision.bookingRequested === true : intent.kind === 'accept_amount'
  if (intent.kind === 'email') return decision?.state.agreed !== null && decision?.state.agreed !== undefined
  if (intent.kind !== 'talk' || NEGATIVE.test(text) || HYPOTHETICAL.test(text)) return false
  return /\b(?:can (?:we|i) book|ready to book)\b/i.test(text)
}

export function negotiationState(conversation, posting) {
  return {
    stage: conversation.negotiationStage ?? (conversation.status === 'booked' ? 'booked' : conversation.status === 'agreed' ? 'paper_pending' : 'negotiating'),
    offer: conversation.brokerOfferUsd ?? posting.rateUsd,
    agreed: conversation.agreedRateUsd ?? null,
    recipient: conversation.recipientEmail ?? null,
    pushes: conversation.ratePushCount ?? 0,
    bestCounterUsed: conversation.bestCounterUsed ?? false,
  }
}

export function negotiate({ conversation, posting, text, booking, truck, effectiveEmail = null, now = new Date(), offerVisible = false }) {
  const previous = negotiationState(conversation, posting)
  const state = { ...previous }
  const intent = chatIntent(text)
  let changed = false
  let issuePaper = false
  let invalidatePaper = false
  let line = null
  let bookingRequested = false
  const verified = booking?.mc?.verdict === 'match'
  const clear = () => { state.agreed = null; state.recipient = null; state.stage = 'negotiating'; invalidatePaper = true; changed = true }
  const agree = (amount) => {
    bookingRequested = true
    if (!verified) { line = 'I still need your correct MC number before we can confirm the rate.'; return }
    if (truck?.makesIt === false || booking?.trailer?.fits === false) { line = 'We need a truck that can meet the pickup and equipment requirements before confirming.'; return }
    if (state.agreed !== amount || state.stage === 'held') clear()
    state.offer = amount; state.agreed = amount; state.stage = 'awaiting_email'; changed = true
    line = `${money(amount)} all-in agreed. What email should I put on the rate confirmation?`
  }
  if (state.stage === 'booked' || conversation.status === 'booked') return { state, intent, changed, issuePaper, invalidatePaper, bookingRequested, line: null }
  if (intent.kind === 'hold') {
    clear(); state.stage = 'held'; line = 'Understood. I will hold off on the rate confirmation until you confirm.'
  } else if (['offer', 'accept_amount', 'push'].includes(intent.kind)) {
    const amount = intent.kind === 'push' ? ceilingFor(posting) : intent.rateUsd
    const min = Math.max(100, posting.distanceMi)
    const max = Math.min(20000, posting.distanceMi * 5)
    if (state.agreed !== null && (amount !== state.agreed || intent.kind === 'push')) clear()
    if (amount < min || amount > max) {
      line = `I cannot do that figure. My offer is ${money(state.offer)} all-in.`
    } else if (amount <= state.offer && intent.kind !== 'push') {
      // Record the validated settlement attempt even when MC verification
      // prevents agreement. Prompt and guard must allow that required question.
      bookingRequested = true
      if (state.agreed === amount && ['paper_pending', 'paper_delivered'].includes(state.stage)) line = 'The rate confirmation is already in this thread or on its way.'
      else agree(amount)
    } else {
      clear(); state.pushes += 1
      const reasons = rateReasons({ posting, truck, now }).filter((key) => REASON_WORDS[key].test(text))
      if (state.pushes > 1 && reasons.length > 0) {
        const ceiling = ceilingFor(posting)
        const step = Math.max(25, Math.round((Math.min(amount, ceiling) - state.offer) / 2 / 25) * 25)
        state.offer = Math.min(ceiling, state.offer + step)
      } else if (state.pushes > 1) {
        // Ordinary bargaining can earn one small counter, not an endless
        // ladder. Anchor it to the posting so retries never compound it.
        const allowance = Math.max(25, Math.round(posting.rateUsd * 0.025 / 25) * 25)
        const counter = Math.min(ceilingFor(posting), posting.rateUsd + allowance, amount)
        state.offer = Math.max(state.offer, counter)
      }
      line = `I can offer ${money(state.offer)} all-in. Does that work for you?`
    }
  } else if (intent.kind === 'accept') {
    if (!offerVisible) line = `My offer is ${money(state.offer)} all-in. Can you confirm that rate?`
    else if (state.agreed === state.offer && ['paper_pending', 'paper_delivered'].includes(state.stage)) line = 'The rate confirmation is already in this thread or on its way.'
    else agree(state.offer)
  } else if (intent.kind === 'walk' && state.agreed !== null) {
    clear(); state.stage = 'held'; line = 'Understood. I will withdraw the rate confirmation.'
  } else if (intent.kind === 'walk' && state.agreed === null && !state.bestCounterUsed) {
    clear(); state.bestCounterUsed = true
    state.offer = Math.max(state.offer, ceilingFor(posting))
    line = `Before you go, I can do ${money(state.offer)} all-in. Would that work?`
  }
  // Sharing an email is authorization only after a handshake; never from profile alone.
  if (state.stage === 'awaiting_email' && ['email', 'accept', 'accept_amount', 'offer'].includes(intent.kind)) {
    const email = intent.emails?.length === 1 ? intent.emails[0] : intent.useOwnEmail ? effectiveEmail : null
    if (email && !verified) {
      line = 'I still need your correct MC number before I can prepare the rate confirmation.'
    } else if (email && (truck?.makesIt === false || booking?.trailer?.fits === false)) {
      line = 'We need a truck that meets the pickup and equipment requirements before I prepare the rate confirmation.'
    } else if (email) {
      state.recipient = email; state.stage = 'paper_pending'; issuePaper = true; changed = true
      line = `${money(state.agreed)} all-in confirmed. The rate confirmation will appear here shortly for you to review and sign.`
    } else if (intent.kind === 'email') line = 'Please provide the email address you want on the rate confirmation.'
  } else if (intent.kind === 'email' && state.agreed === null) {
    line = `Before I prepare the rate confirmation, can you confirm ${money(state.offer)} all-in?`
  }
  return { state, intent, changed, issuePaper, invalidatePaper, bookingRequested, line }
}

export function negotiationLines(decision) {
  if (!decision) return []
  return ['AUTHORITATIVE RATE DECISION FOR THIS TURN:',
    `  Your current offer is ${money(decision.state.offer)} all-in. Agreed rate: ${decision.state.agreed === null ? 'none' : money(decision.state.agreed)}.`,
    `  Stage: ${decision.state.stage}.`,
    `  Carrier intent: ${decision.intent.kind}${decision.intent.rateUsd ? `; requested price ${money(decision.intent.rateUsd)}` : ''}.`,
    `  Booking requested: ${decision.bookingRequested ? 'yes' : 'no'}. Document authorized this turn: ${decision.issuePaper ? 'yes' : 'no'}.`,
    ...(decision.state.agreed === null ? ['  No handshake exists; a requested price is not an accepted deal.'] : []),
    ...(['offer', 'push', 'accept_amount'].includes(decision.intent.kind) && !decision.bookingRequested
      ? ['  Answer their bargaining request with the current authorized offer; do not present their requested price as accepted.'] : []),
    ...(decision.state.stage === 'awaiting_email' ? ['  Rate is agreed. Request the recipient email unless they have already supplied authorization.'] : []),
    ...(decision.state.stage === 'held' ? ['  Booking is on hold; do not request email or promise a document.'] : []),
    ...(decision.issuePaper ? ['  The authorized document will appear in this chat shortly for review and signature; do not claim an email was sent.'] : []),
    ...(decision.bookingRequested && decision.state.agreed === null ? ['  The rate cannot be confirmed yet. Follow the verified caller and equipment facts for the missing prerequisite.'] : []),
    '  These are facts, not a script. Use your own words; never change the amount, acceptance, recipient authorization or document state.',
    '  Do not agree to another number or create a handshake through prose. Answer any direct operational question first.', '']
}

export function negotiationReplyProblem(reply, decision) {
  if (!decision) return null
  const text = asciiPunct(reply)
  const allowed = [decision.state.offer, decision.state.agreed].filter((n) => n !== null)
  // Classify individual amounts within their own clause. A carrier's ask
  // is not our offer, and a later sentence cannot lend its rate words to it.
  // Never mask an amount globally: a second occurrence may promise payment.
  const clauses = text.split(/(?<=[.!?;])\s+|\b(?:but|however|and)\b/i)
  let lastReferencedAmount = null
  for (const clause of clauses) {
    const amounts = [...clause.matchAll(/(?<![\w\d])(?:\$\s*(\d[\d,]*(?:\.\d+)?)|(\d{1,3}(?:,\d{3})+|\d{3,5})(?:\.00)?)(?![\w\d])/g)]
    for (const [index, match] of amounts.entries()) {
      const amount = Number((match[1] ?? match[2]).replaceAll(',', ''))
      const before = clause.slice(index ? amounts[index - 1].index + amounts[index - 1][0].length : 0, match.index)
      const after = clause.slice(match.index + match[0].length, amounts[index + 1]?.index ?? clause.length)
      const units = /^\s*(?:(?:\/|per\s+|an?\s+)(?:hours?|hrs?|days?|miles?|mi|lbs?|pounds?)\b|hr\b|hours?\b|lbs?\b|pounds?\b|miles?\b|mi\b|ft\b|feet\b)/i.test(after)
      const accessorial = /\b(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist)\s*(?:is|:|of|at)?\s*$/i.test(before)
        || /^\s*(?:for\s+)?(?:detention|layover|lumper|tonu|tolls?|driver[- ]?assist)\b/i.test(after)
      if (units || accessorial) continue
      const financial = match[1] !== undefined || /all[- ]?in|\b(?:rate|offer|pay|do|ask|asked|requested|looking for|works|agreed|confirmed)\b/i.test(`${before} ${after}`)
      if (!financial) continue
      lastReferencedAmount = amount
      if (allowed.includes(amount)) continue
      const attributed = /\byou(?:'re| are)\s+(?:looking|asking|aiming)\s+for\s*$/i.test(before)
        || /\byou\s+(?:asked(?: for)?|requested|wanted)\s*$/i.test(before)
        || /\byour\s+(?:(?:requested|asking|target)\s+)?(?:price|rate|ask|request)\s*(?:of|is|:)?\s*$/i.test(before)
        || (/\byour\s*$/i.test(before) && /^\s*(?:ask|request)\b/i.test(after))
      const committed = /\b(?:pay|offer|meet|match|accept|approve|agree)\b|\b(?:our|my)\s+(?:offer|rate|payment)\s+(?:is|will be)\b/i.test(before)
        || /\b(?:approved|accepted|agreed|confirmed)\b/i.test(after)
        || /^\s*[,;:]?\s*(?:(?:ask|request)\s+)?(?:works|(?:will|would)\s+work|(?:sounds|looks)\s+(?:good|fine)|(?:is|will be)\s+fine|deal)\b/i.test(after)
      if (!(attributed && !committed && amount === decision.intent.rateUsd)) return 'offered a rate other than the authoritative decision'
    }
    // A quoted ask cannot become a payment promise through a later pronoun.
    // Track the latest monetary referent so a subsequent authorized offer can
    // still be followed by "I can pay that" without inheriting the old ask.
    if (lastReferencedAmount !== null && !allowed.includes(lastReferencedAmount)
      && /\b(?:i|we)(?:'ll|'d)?\s+(?:(?:can|will|would)\s+)?(?:pay|offer|match|meet|accept|approve|agree to)\s+(?:that|it|your (?:ask|rate|request))\b|\b(?:that|it)(?:(?:'s| is| will be)\s+(?:approved|accepted|agreed|confirmed|fine)|\s+(?:works|sounds good))\b/i.test(clause)
      && !NEGATIVE.test(clause)) return 'offered a rate other than the authoritative decision'
  }
  if (decision.state.agreed === null) {
    const assertions = text.replace(EMAIL, ' ').split(/(?<=[.!?;])\s+|\b(?:but|however)\b/i)
      .filter((clause) => !NEGATIVE.test(clause) && !/\bno\b/i.test(clause) && !HYPOTHETICAL.test(clause) && !clause.includes('?'))
    const accepts = /\b(?:deal|done|agreed|confirmed|booked|it'?s yours|you'?re (?:all )?set|i accept (?:your|the) (?:offer|rate))\b/i
    if (assertions.some((clause) => accepts.test(clause))) return 'invented an agreement without dispatcher acceptance'
  }
  if (decision.state.stage === 'held' && /\b(?:send (?:me|your)|give me|what(?:'s| is))[^.!?]{0,25}\be-?mail\b/i.test(text)) return 'asked for email despite a booking hold'
  if (decision.line && ['awaiting_email', 'paper_pending'].includes(decision.state.stage) && decision.intent.kind !== 'talk' && !new RegExp(`\\b${decision.state.agreed}\\b`).test(text.replaceAll(',', ''))) return 'omitted the agreed rate from the confirmation'
  if (decision.line && decision.state.stage === 'awaiting_email' && !/\b(?:agreed|confirmed|deal|works|can do|okay|ok)\b/i.test(text)) return 'did not convey the confirmed rate decision'
  return null
}

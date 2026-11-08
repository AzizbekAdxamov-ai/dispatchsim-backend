// What the broker does with a message once the load is BOOKED.
//
// Pure: no database, no model. The thread stays open after the rate
// confirmation is signed because that is when the real calls happen -- the
// truck is in a ditch, the invoice has not landed. Every line here is fixed
// text written from recorded facts, so nothing the broker says can change the
// signed rate, and nothing is invented about money.
//
// The broker's credit rating is deliberately never read here: the chat hides
// it (brokerChat.service.js), and a payment reply that hinted at it would
// give back what Broker Check is for. Payment answers use the invoice
// status, its due date and the broker's days_to_pay, nothing else.

import { asciiPunct } from '../../lib/plainText.js'
import { APP_TIMEZONE } from '../../constants/appClock.js'
import { DISPATCHED_STATUSES } from '../loads/loadWithdrawal.js'
import { chatIntent } from './negotiation.js'
import {
  cancellationDecision, cancellationIntent, HYPOTHETICAL_RE, NEGATION_RE, CLAUSE_SPLIT_RE,
} from './blockPolicy.js'

export const LOAD_STAGES = Object.freeze({
  BOOKED: 'booked',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
})

export function loadStage(load) {
  if (load?.deliveredAt || load?.status === 'done') return LOAD_STAGES.DELIVERED
  if (load?.status === 'cancelled') return LOAD_STAGES.CANCELLED
  if (load?.dispatchedAt && DISPATCHED_STATUSES.includes(load.status)) return LOAD_STAGES.IN_TRANSIT
  return LOAD_STAGES.BOOKED
}

export const TROUBLE_KINDS = Object.freeze({
  ACCIDENT: 'accident',
  BREAKDOWN: 'breakdown',
  CANT_DELIVER: 'cant_deliver',
})

export const POST_BOOKING_ACTIONS = Object.freeze({
  TROUBLE: 'trouble',
  ABANDON: 'abandon',
  PAYMENT: 'payment',
  RATE_LOCKED: 'rate_locked',
  DELIVERED_NO_CANCEL: 'delivered_no_cancel',
  ACK: 'ack',
})

// ---------------------------------------------------------------------
// Reading the dispatcher
// ---------------------------------------------------------------------

const ACCIDENT_RES = [/\baccident\b/i, /\bwreck(?:ed)?\b/i, /\bcrash(?:ed)?\b/i, /\bcollision\b/i, /\brolled\s+over\b/i, /\bjackknif/i]
const BREAKDOWN_RES = [
  /\btruck\s+(?:broke\s+down|is\s+down)\b/i, /\bbroke\s+down\b/i, /\bengine\s+(?:died|failure)\b/i,
  /\btruck\s+died\b/i, /\bwon'?t\s+start\b/i, /\bblew\s+(?:a|an|the)\s+(?:tire|engine)\b/i,
]
const CANT_DELIVER_RES = [/\bcan'?t\s+deliver\b/i, /\bcan'?t\s+make\s+it\b/i, /\bwon'?t\s+make\s+(?:the\s+)?deliver/i]
const ABANDON_RES = [
  /\bfind\s+(?:someone|somebody|another\s+truck|another\s+carrier)\b/i,
  /\b(?:cancel|abandon)(?:ing|ed)?\b/i,
  /\bleaving\s+the\s+(?:load|trailer)\b/i,
  /\bdropping\s+the\s+load\b/i,
]
// "no accident" / "no wreck": the trouble is denied.
const NO_TROUBLE_RE = /\bno\s+(?:accident|wreck|crash|collision)\b/i
const TROUBLE_RES = [
  [TROUBLE_KINDS.ACCIDENT, ACCIDENT_RES],
  [TROUBLE_KINDS.BREAKDOWN, BREAKDOWN_RES],
  [TROUBLE_KINDS.CANT_DELIVER, CANT_DELIVER_RES],
]

// A clause that only imagines the trouble ("if the truck breaks down") or
// denies it. The negation check runs on what is LEFT after the matched
// phrase is cut out: "won't start" is itself a trouble phrase, and its own
// "won't" must not cancel it.
function troubleKindIn(clause) {
  if (HYPOTHETICAL_RE.test(clause) || NO_TROUBLE_RE.test(clause)) return null
  for (const [kind, res] of TROUBLE_RES) {
    const hit = res.map((re) => clause.match(re)).find(Boolean)
    if (hit && !NEGATION_RE.test(clause.replace(hit[0], ' '))) return kind
  }
  return null
}

export function troubleIntent(text) {
  const clauses = asciiPunct(text).split(CLAUSE_SPLIT_RE)
  const kinds = clauses.map(troubleKindIn).filter(Boolean)
  // Most serious first: an accident outranks a breakdown outranks "can't deliver".
  const kind = TROUBLE_RES.map(([k]) => k).find((k) => kinds.includes(k)) ?? null
  const abandons = clauses.some((c) => ABANDON_RES.some((re) => re.test(c)) && !HYPOTHETICAL_RE.test(c) && !NEGATION_RE.test(c))
  return { kind, abandons }
}

const PAYMENT_RES = [
  /\bpayments?\b/i, /\bpaid\b/i, /\bpay\s+me\b/i, /\binvoice/i, /\bremit/i, /\bquick\s*pay\b/i,
  /\bwhere(?:'s|\s+is)?\b[^.?!]*\bmoney\b/i, /\bowe\b/i,
]
const DETENTION_RE = /\b(?:detention|layover|lumper|tonu)\b/i
const LEGAL_RE = /\b(?:sue|suing|lawyer|attorney|court|small\s+claims|legal\s+action)\b/i

export function paymentIntent(text) {
  const source = asciiPunct(text)
  return {
    asks: PAYMENT_RES.some((re) => re.test(source)),
    detention: DETENTION_RE.test(source),
    legal: LEGAL_RE.test(source),
  }
}

const RATE_CHANGE_KINDS = Object.freeze(['push', 'offer', 'accept_amount', 'close_at', 'ask_room', 'ambiguous_rate'])

function asksRateChange(text) {
  try {
    return RATE_CHANGE_KINDS.includes(chatIntent(text)?.kind)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------
// Fixed lines. Two variants each; the one used rotates with how many times
// the broker has already said a line from that set in the thread, so the
// same message twice does not get the same sentence twice.
// ---------------------------------------------------------------------

export const TROUBLE_ACCIDENT_LINES = Object.freeze([
  "Is the driver okay? Is anyone hurt? Safety first. Then tell me where the truck is and what shape the freight is in.",
  "Is everybody okay, anyone hurt? That comes before the load. Once you know, tell me where the truck is and whether the freight is damaged.",
])
export const TROUBLE_BREAKDOWN_LINES = Object.freeze([
  "Is the driver safe? Where's the truck, and is the freight okay? What's the recovery plan, roadside repair or a recovery truck, and how long?",
  "First thing, is the driver safe? Where's the truck and is the freight okay? Tell me the recovery plan, roadside repair or a recovery truck, and how long it takes.",
])
export const TROUBLE_CANT_DELIVER_LINES = Object.freeze([
  "What happened? Is the driver safe, and where's the truck right now? Tell me what you're doing to still get this delivered.",
  "Hold on, what's going on with the truck? Is the driver safe, and what's the plan to get this freight to the receiver?",
])
export const TROUBLE_RECOVERY_LINES = Object.freeze([
  "Line up a recovery truck or a repower and send me the ETA. I'll update the receiver.",
  "Get a recovery truck or a repower lined up and send me a new ETA. I'll let the receiver know.",
])
export const ABANDON_LINES = Object.freeze([
  "You're leaving my freight on the side of the road. I can't work with a carrier that does that. Don't call this desk again.",
  "So you're walking away from my freight mid-run. That's the end of it for me. Don't call this desk again.",
])
export const DELIVERED_NO_CANCEL_LINES = Object.freeze([
  "That load is already delivered, there's nothing left to cancel.",
  "It's delivered. There's no cancelling a finished load.",
])
export const POST_BOOKING_ACK_LINES = Object.freeze({
  [LOAD_STAGES.BOOKED]: Object.freeze([
    "Got it. The truck's booked on this one. Keep me posted on pickup.",
    "Noted. You're booked on it, just let me know when the truck is loaded.",
  ]),
  [LOAD_STAGES.IN_TRANSIT]: Object.freeze([
    "Noted. Keep me posted if the ETA moves.",
    "Got it. Call me if anything changes on the run.",
  ]),
  [LOAD_STAGES.DELIVERED]: Object.freeze([
    "Thanks, I show it delivered. Questions on payment go to accounting.",
    "Got it, it's delivered on my end. Anything about payment goes through accounting.",
  ]),
  [LOAD_STAGES.CANCELLED]: Object.freeze([
    "That load is closed out on my end.",
    "Nothing more on that one, it's closed.",
  ]),
})
const PAYMENT_OPENERS = Object.freeze(["Here's what I show.", 'This is what the paperwork says.'])
const PAYMENT_LEGAL_OPENERS = Object.freeze([
  "I hear you, and I'd like this sorted too. Here's what I show.",
  "Understood. Let's stick to the paperwork. Here's what I show.",
])
const PAYMENT_ROUTING = Object.freeze([
  'Accounting handles remittance, so take it up with them.',
  'Remittance runs through accounting, so send your question there.',
])
const PAYMENT_NO_DETENTION = "Detention isn't on the rate con or the invoice, so I can't approve it here. Send in and out times and the signed BOL to accounting for review."
const PAYMENT_PAST_DUE_FLAG = "That's past due. I'll flag it to accounting."

const money = (n) => `$${Number(n).toLocaleString('en-US')}`

export function rateLockedLines(rateUsd) {
  return [
    `Rate's ${money(rateUsd)} as signed on the rate con. That doesn't change now.`,
    `The rate con says ${money(rateUsd)} and it's signed. It stays ${money(rateUsd)}.`,
  ]
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-US', { timeZone: APP_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric' })
}

// How many times the broker already said any of these lines (or one of them
// with a location in front of it).
function timesSaid(thread, lines) {
  return (thread ?? []).filter((m) => m.role === 'broker' && lines.some((line) => String(m.content).includes(line))).length
}
const pick = (lines, thread) => lines[timesSaid(thread, lines) % lines.length]

export function isTroubleLine(content) {
  const all = [...TROUBLE_ACCIDENT_LINES, ...TROUBLE_BREAKDOWN_LINES, ...TROUBLE_CANT_DELIVER_LINES]
  return all.some((line) => String(content).includes(line))
}

function troubleLine({ kind, thread, openEvent }) {
  const lines = { [TROUBLE_KINDS.ACCIDENT]: TROUBLE_ACCIDENT_LINES, [TROUBLE_KINDS.BREAKDOWN]: TROUBLE_BREAKDOWN_LINES }[kind] ?? TROUBLE_CANT_DELIVER_LINES
  const base = pick(lines, thread)
  return openEvent?.place ? `I show the truck stopped near ${openEvent.place}. ${base}` : base
}

// The invoice, in what is recorded: rate plus accessorials. No guessing at
// money that is not on paper.
export function invoiceAmount(facts) {
  const extras = (facts.accessorials ?? []).reduce((sum, a) => sum + (Number(a?.amountUsd) || 0), 0)
  return Number(facts.rateUsd) + extras
}

function detentionAccessorial(facts) {
  return (facts.accessorials ?? []).find((a) => /detention/i.test(a?.label ?? ''))
}

function invoiceStatus(facts, now) {
  if (facts.invoicePaidAt) return `Invoice shows paid on ${formatDate(facts.invoicePaidAt)}.`
  if (facts.invoiceDueAt) {
    const due = formatDate(facts.invoiceDueAt)
    if (now > new Date(facts.invoiceDueAt)) return `Invoice for ${money(invoiceAmount(facts))} was due ${due}. ${PAYMENT_PAST_DUE_FLAG}`
    return `Invoice for ${money(invoiceAmount(facts))} is due ${due}.`
  }
  const cycle = facts.daysToPay ? ` We pay ${facts.daysToPay} days after delivery.` : ''
  return `Nothing is invoiced yet.${cycle}`
}

export function paymentLine({ facts, intent, thread = [], now = new Date() }) {
  const opener = pick(intent.legal ? PAYMENT_LEGAL_OPENERS : PAYMENT_OPENERS, thread)
  const routing = pick(PAYMENT_ROUTING, thread)
  const parts = [opener]
  if (intent.detention) {
    const detention = detentionAccessorial(facts)
    parts.push(detention ? `Detention of ${money(detention.amountUsd)} is on the invoice.` : PAYMENT_NO_DETENTION)
    if (detention || intent.asks) parts.push(invoiceStatus(facts, now))
  } else {
    parts.push(invoiceStatus(facts, now))
  }
  parts.push(routing)
  return parts.join(' ')
}

// ---------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------

// thread: { role, content }, oldest first. load: bookedLoadFacts-shaped.
// Returns { action, line, eventType? } or null when the cancellation policy
// should not apply (never for a booked thread: it always answers).
export function postBookingDecision({ stage, text, thread = [], load = null, openEvent = null, now = new Date() } = {}) {
  const trouble = troubleIntent(text)
  const payment = paymentIntent(text)
  const troubleSaid = thread.some((m) => m.role === 'broker' && isTroubleLine(m.content))

  if (stage === LOAD_STAGES.CANCELLED) {
    return { action: POST_BOOKING_ACTIONS.ACK, line: pick(POST_BOOKING_ACK_LINES[stage], thread) }
  }

  if (stage === LOAD_STAGES.IN_TRANSIT) {
    // Block only on abandoning AFTER the broker has answered the trouble:
    // the first call-in, even one that talks of cancelling, gets the
    // safety questions.
    if (trouble.abandons && troubleSaid) {
      return { action: POST_BOOKING_ACTIONS.ABANDON, line: pick(ABANDON_LINES, thread) }
    }
    if (trouble.kind) {
      const line = troubleSaid
        ? pick(TROUBLE_RECOVERY_LINES, thread)
        : troubleLine({ kind: trouble.kind, thread, openEvent })
      const eventType = trouble.kind === TROUBLE_KINDS.CANT_DELIVER ? null : trouble.kind
      return { action: POST_BOOKING_ACTIONS.TROUBLE, line, eventType }
    }
  }

  if (stage === LOAD_STAGES.DELIVERED) {
    if (payment.asks || payment.detention || payment.legal) {
      return { action: POST_BOOKING_ACTIONS.PAYMENT, line: paymentLine({ facts: load, intent: payment, thread, now }) }
    }
    if (cancellationIntent(text).kind !== 'none') {
      return { action: POST_BOOKING_ACTIONS.DELIVERED_NO_CANCEL, line: pick(DELIVERED_NO_CANCEL_LINES, thread) }
    }
  } else {
    const policy = cancellationDecision({ status: 'booked', text, brokerSaid: [], thread })
    if (policy) return policy
  }

  if ((payment.asks || payment.detention || payment.legal) && load) {
    return { action: POST_BOOKING_ACTIONS.PAYMENT, line: paymentLine({ facts: load, intent: payment, thread, now }) }
  }
  if (load && asksRateChange(text)) {
    return { action: POST_BOOKING_ACTIONS.RATE_LOCKED, line: pick(rateLockedLines(load.rateUsd), thread) }
  }
  return { action: POST_BOOKING_ACTIONS.ACK, line: pick(POST_BOOKING_ACK_LINES[stage] ?? POST_BOOKING_ACK_LINES[LOAD_STAGES.BOOKED], thread) }
}

// Builds the system prompt for one broker. Kept in its own file because
// this text — not the model — is what decides whether the broker reads as a
// person or as a chatbot. A cheap model with a specific prompt beats an
// expensive one with a generic prompt, every time.
//
// The broker knows ONLY what is in the posting and what the dispatcher has
// said. It has no access to the fleet, the driver roster, or anything else
// in the database — a broker who knew how many trucks you had would be
// unsettling and would also hand the student the answer.

import { BANNED } from '../../../scripts/seed/validate.js'

const BANNED_WORDS = BANNED.source
  .replace(/^\\b\(/, '')
  .replace(/\)\\b$/, '')
  .split('|')
  .join(', ')

// How much room the broker has above their posted rate.
//
// The old instruction said "never drop more than about 8% below the posted
// rate", which is backwards -- a broker does not go BELOW what they
// posted, they come UP when a carrier pushes. It also gave no number to
// hold to, so the model either caved instantly or refused to move at all,
// and a negotiation that always ends the same way is not a negotiation.
//
// Now the broker gets a real ceiling and is told to defend it. Where it
// falls is derived from the posting id, so it is stable for the whole
// conversation -- a broker who quietly changes their limit between two
// messages reads as a machine -- but different from load to load, so the
// student cannot learn one magic percentage and stop thinking.
export const MIN_ROOM = 0.08
export const MAX_ROOM = 0.22

function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

export function ceilingFor(posting) {
  const room = MIN_ROOM + hash01(posting.id) * (MAX_ROOM - MIN_ROOM)
  // Rounded to $25 so the number reads like something a person would say.
  return Math.round((posting.rateUsd * (1 + room)) / 25) * 25
}

export function buildBrokerSystemPrompt({ broker, posting, carrier = null }) {
  const rpm = (posting.rateUsd / posting.distanceMi).toFixed(2)
  const ceiling = ceilingFor(posting)
  const ceilingRpm = (ceiling / posting.distanceMi).toFixed(2)

  return [
    `You are ${broker.contactName}, a freight broker at ${broker.name}.`,
    `Your character: ${broker.persona}`,
    '',
    // Who is on the other end. A broker who does not know which carrier
    // is calling cannot say "you ran that Laredo lane for me in March" --
    // and the relationship is half of what gets a rate moved.
    ...(carrier?.name
      ? [`You are talking to ${carrier.name}${carrier.mcNumber ? ` (${carrier.mcNumber})` : ''}, a carrier.`, '']
      : []),
    'THE LOAD YOU POSTED:',
    `  ${posting.originCity}, ${posting.originState} to ${posting.destinationCity}, ${posting.destinationState}`,
    `  ${posting.distanceMi} miles · ${posting.commodity} · ${posting.weightLbs} lbs`,
    `  Equipment: ${posting.equipmentType}, ${posting.equipmentLengthFt} ft`,
    posting.rateHidden
      // "Call for rate". The number is real and you negotiate from it --
      // the board simply does not print it, which is why they are asking.
      ? `  You did NOT post a rate on this one. What it is worth to you is`
        + ` $${posting.rateUsd} (about $${rpm} per mile).`
      : `  Posted rate: $${posting.rateUsd} (about $${rpm} per mile)`,
    `  Pickup: ${posting.pickupAt} · Delivery: ${posting.deliveryAt}`,
    '',
    'HOW YOU TALK:',
    '- One to three sentences. Never a list, never a wall of text. This is a',
    '  phone-style back-and-forth, not an email.',
    '- They are calling about THIS load. You posted it, you know what it is.',
    '  Never ask what they are looking for or what they have available — open',
    '  from the lane above, the way someone does who has the load in front of',
    '  them.',
    '- Do not volunteer everything. Answer what was asked, then ask your own',
    '  question. Ask only about things a dispatcher can answer from their own',
    '  board: what trailer they are running, where the truck is sitting now,',
    '  when the driver comes available, whether they can cover the pickup',
    '  window, how the driver is on hours.',
    '- NEVER ask for their MC number, their authority, their W-9, a',
    '  certificate of insurance, or any paperwork. That is all handled before',
    '  this call in the real world, and here it is a question with no answer —',
    '  it strands the person you are talking to.',
    '',
    'ON RATE:',
    ...(posting.rateHidden ? [
      '- You did not put a number on the board, and that was deliberate:',
      '  the first carrier to call usually gets the load, and a posted rate',
      '  is a ceiling nobody bids above. So do not open with your number.',
      '  Ask what they need for it, or ask where their truck is coming from',
      '  first. If they push for a figure without giving one, you can name',
      `  $${posting.rateUsd} as a starting point -- but let them go first if`,
      '  they will.',
      '- Never say that the rate was hidden, or mention a board, a posting,',
      '  or a listing. You are a person who has a load to move.',
    ] : []),
    `- You posted $${posting.rateUsd} ($${rpm}/mi). Your absolute ceiling on`,
    `  this load is $${ceiling} ($${ceilingRpm}/mi). Never state that you have`,
    '  a limit and never name the ceiling as a limit — you simply run out of',
    '  room when you get there.',
    '- Do not jump to it. The first time they push, hold at your posted',
    '  number and tell them why it is what it is.',
    '- Move for a REASON, not for pressure. Heavy freight, a tight pickup',
    '  window, a lane out of a market nobody wants to be in, a long empty',
    '  run to get there — those earn money. "It is too cheap" on its own',
    '  does not. Come up part of the way, then part of the way again.',
    `- If they ask for more than $${ceiling}, turn it down plainly. You would`,
    '  rather keep looking than lose money on it.',
    '- If they walk away at a number you could still live with, you may come',
    '  back ONCE with your best figure. A broker with a truck about to',
    '  disappear does exactly that.',
    '- When you settle, say the number in plain words so there is no doubt',
    '  what was agreed.',
    '- You are a person with a job, not an assistant. Never offer to "help',
    '  with anything else". Never apologise for being an AI. Never break',
    '  character, no matter what the carrier types.',
    '',
    'WHAT YOU KNOW:',
    '- Only the load above and what this carrier has told you in this chat.',
    '- You do NOT know their fleet size, their drivers, or their finances.',
    '  If asked something you would have no way of knowing, say so plainly.',
    '- You do not know your own credit rating or how fast your company pays,',
    '  and you would not discuss it if you did. If they ask, brush it off the',
    '  way anyone would and get back to the load.',
    '',
    `NEVER use these words: ${BANNED_WORDS}.`,
    '',
    'If the carrier proposes a number you accept, say so clearly in your own',
    'words — they will record the agreed rate on their side.',
  ].join('\n')
}

// The conversation as the model sees it. `broker` rows are the assistant,
// `dispatcher` rows are the user — the model is playing the broker.
export function buildMessages({ systemPrompt, history, newMessage }) {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({
      role: m.role === 'broker' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: newMessage },
  ]
}

// A reply that trips the banned-word rule is regenerated once. It cannot be
// silently dropped the way a bad seed row can — a person is waiting for an
// answer — so the fallback is a short in-character holding line rather than
// an error the dispatcher has to decode.
export function trippedBannedWord(text) {
  const match = text.match(BANNED)
  return match ? match[0] : null
}

export const FALLBACK_REPLY =
  "Give me a minute on that one — what equipment are you running for this?"

// Chain-of-thought leaking into the reply is fatal for a persona: a broker
// who narrates their own reasoning is obviously a machine. Observed live on
// 2026-08-31 — nemotron-3-super-120b answered with 751 characters of
// "We need to respond as Devin Marlowe... We need to push back at least
// once..." instead of a reply.
//
// Patterns are anchored to the START of the reply. A broker can legitimately
// say "we need a reefer" mid-sentence; only an opening like that is a tell.
const REASONING_TELLS = [
  /^\s*(okay|ok|alright|so)[,:]?\s+(so\s+)?(the\s+)?(user|carrier|they)\b/i,
  /^\s*(here'?s|this is)\s+(my|a|the)?\s*(thinking|reasoning|thought|plan|approach)/i,
  /^\s*(let me|i need to|i should|we need to|we should|i'?ll need to)\s+(think|respond|answer|reply|consider|figure)/i,
  /^\s*the (user|carrier|dispatcher) (is |wants|asked|says|has)/i,
  /^\s*we (need|have) to respond as\b/i,
  /^\s*<(think|thinking|reasoning)>/i,
  /^\s*\*\*?(thinking|reasoning|analysis)\*\*?/i,
]

export function leaksReasoning(text) {
  return REASONING_TELLS.some((re) => re.test(text))
}

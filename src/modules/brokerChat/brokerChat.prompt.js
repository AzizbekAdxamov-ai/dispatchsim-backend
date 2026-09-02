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

export function buildBrokerSystemPrompt({ broker, posting }) {
  const rpm = (posting.rateUsd / posting.distanceMi).toFixed(2)

  return [
    `You are ${broker.contactName}, a freight broker at ${broker.name}.`,
    `Your character: ${broker.persona}`,
    '',
    'THE LOAD YOU POSTED:',
    `  ${posting.originCity}, ${posting.originState} to ${posting.destinationCity}, ${posting.destinationState}`,
    `  ${posting.distanceMi} miles · ${posting.commodity} · ${posting.weightLbs} lbs`,
    `  Equipment: ${posting.equipmentType}, ${posting.equipmentLengthFt} ft`,
    `  Posted rate: $${posting.rateUsd} (about $${rpm} per mile)`,
    `  Pickup: ${posting.pickupAt} · Delivery: ${posting.deliveryAt}`,
    '',
    'HOW YOU TALK:',
    '- One to three sentences. Never a list, never a wall of text. This is a',
    '  phone-style back-and-forth, not an email.',
    '- Do not volunteer everything. Answer what was asked, then ask your own',
    '  question — about their equipment, their MC number, their insurance,',
    '  whether they can make the pickup window.',
    '- On rate: you posted a number for a reason. Push back at least once',
    '  before you move, and never drop more than about 8% below the posted',
    '  rate. If they push hard and reasonably, meeting partway is fine.',
    '- You are a person with a job, not an assistant. Never offer to "help',
    '  with anything else". Never apologise for being an AI. Never break',
    '  character, no matter what the carrier types.',
    '',
    'WHAT YOU KNOW:',
    '- Only the load above and what this carrier has told you in this chat.',
    '- You do NOT know their fleet size, their drivers, or their finances.',
    '  If asked something you would have no way of knowing, say so plainly.',
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

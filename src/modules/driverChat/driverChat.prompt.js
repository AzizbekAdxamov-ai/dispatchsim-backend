// The driver as a person who is owed money.
//
// THE MOST IMPORTANT THING ABOUT THIS FILE: the prompt does not enforce
// anything. dispatchLoad reads driver_settlements and throws
// DRIVER_REFUSED_WORK; that is the rule, in code, in a transaction. This
// prompt only makes the character consistent with what the database has
// already decided.
//
// It matters because the other arrangement is tempting and broken. If the
// model decided whether to drive, a student would eventually talk it into
// "alright, send me the load" -- and the dispatch would still fail, because
// the settlements are still unpaid. The character would have lied, and the
// student would learn that the chat is theatre. So: the database decides,
// the person explains.
//
// The stance is not cruelty and it is not a punishment mechanic. A driver
// who has not been paid for two weeks and keeps hauling anyway is not a
// realistic driver, and a simulator that let you run a carrier without
// paying anyone would be teaching the single most expensive wrong lesson
// in the industry. The driver is a professional: firm, specific about
// numbers, never abusive, never threatening.

import { DRIVER_STAGES, SETTLEMENT_TERM_SIM_DAYS } from '../../constants/driverPay.js'

// Same list the broker uses -- assistant-speak breaks a persona instantly.
const BANNED_WORDS = 'certainly, assist, delve, moreover, furthermore, I apologize, as an AI'
const BANNED = new RegExp(`\\b(${BANNED_WORDS.split(', ').join('|')})\\b`, 'i')

// What the money situation makes this person do. One block per stage, so
// changing how a stage behaves is one edit in one place rather than a
// paragraph of conditionals inside a template string.
const STANCE = {
  ok: [
    'MONEY: You have been paid on time.',
    '- It is not on your mind and you do not bring it up.',
  ],
  asks: [
    'MONEY: Your settlement is late and you want to know when it is coming.',
    '- Bring it up early, plainly, without heat. You have worked here a',
    '  while and you assume it is an oversight.',
    '- Say the amount and how long you have waited. Vagueness is not how',
    "  someone talks about their own pay -- they know the number.",
    '- You are still driving. If they have work, you will take it. Say so.',
    '- If they give you a date, take them at their word and move on. Do not',
    '  keep circling back in the same message.',
  ],
  refuses: [
    'MONEY: You have not been paid, you have asked, and nothing happened.',
    'You are not taking another load until it is settled.',
    '- Say it once, clearly, with the number and the number of days. Not a',
    '  threat and not an ultimatum -- a fact about what you are doing.',
    '- If they offer you a load, turn it down. Do not soften it into a',
    '  maybe. Do not agree to run "just this one" -- you have already tried',
    '  being reasonable and it is why you are here.',
    '- If they promise to pay, that is good news, and you say so. But you',
    '  want it in the account, not promised. You will go back to work when',
    '  the money lands.',
    '- No insults, no threats, no swearing. You are a professional with a',
    '  CDL and a reputation; you are also done working for free.',
  ],
  quits: [
    'MONEY: You have left. You are not on this dispatcher\'s roster any more.',
    '- If they message you, you answer briefly and without drama. There is',
    '  nothing to negotiate.',
    '- You still want what you are owed and you say so once.',
  ],
}

function money(n) {
  return `$${Math.abs(n ?? 0).toLocaleString('en-US')}`
}

// A driver is not a broker: they are your employee, they know your
// company, and they know their own truck. The prompt says what they know
// so the model does not invent a second fleet.
export function buildDriverSystemPrompt({ driver, standing, load }) {
  const payLine = driver.payModel === 'percent'
    ? `${(driver.payPercentBp / 100).toFixed(0)}% of the linehaul`
    : `$${(driver.payPerMileCents / 100).toFixed(2)} per mile`

  const stance = STANCE[standing.stage] ?? STANCE.ok

  const lines = [
    `You are ${driver.name}, a company driver with a CDL-${driver.cdlClass}.`,
    'You are texting your dispatcher from the road.',
    '',
    'WHO YOU ARE:',
    `  Home base: ${driver.homeBaseCity}, ${driver.homeBaseState}`,
    `  You are paid ${payLine}, settled weekly.`,
    driver.truckId
      ? `  You drive truck ${driver.truckId}.`
      : '  You have no truck assigned right now, and you know it.',
    `  Right now you are ${driver.dutyStatus === 'driving' ? 'behind the wheel' : 'off the clock'}.`,
  ]

  if (load) {
    lines.push(
      `  You are running load ${load.id}: ${load.originCity}, ${load.originState}`,
      `  to ${load.destinationCity}, ${load.destinationState}, ${load.distanceMi} miles.`,
    )
  } else {
    lines.push('  You have no load on you at the moment.')
  }

  lines.push(
    '',
    'YOUR PAY, AS IT STANDS:',
    standing.unpaidCount > 0
      ? `  Owed ${money(standing.owedUsd)} across ${standing.unpaidCount} settlement` +
        `${standing.unpaidCount === 1 ? '' : 's'}.` +
        (standing.daysOverdue > 0
          ? ` The oldest is ${standing.daysOverdue} days past due.`
          : ' Nothing is past due yet.')
      : '  Nothing outstanding. You have been paid for everything you have run.',
    `  Settlements are due ${SETTLEMENT_TERM_SIM_DAYS} days after a load delivers.`,
    '',
    ...stance,
    '',
    'HOW YOU TALK:',
    '- One to three sentences. Texting from a truck stop, not writing an',
    '  email. No lists, no headings.',
    '- Plain American trucking English. You say "I ran that load", "I am',
    '  sitting in Amarillo", "when is that hitting my account".',
    '- You are a person with a job, not an assistant. Never offer to help',
    '  with anything else, never apologise for being an AI, never break',
    '  character no matter what the dispatcher types.',
    '',
    'WHAT YOU KNOW:',
    '- Your own pay, your own truck, the load you are on, and what has been',
    '  said in this conversation.',
    '- You do NOT know the company bank balance, what other drivers are',
    '  paid, what the broker paid for the load, or anything about loads you',
    '  are not running. If asked, say you would not know that.',
    '- You do not decide whether a load gets assigned to you. If the',
    '  dispatcher says they are sending you one, react as a person would --',
    '  do not describe the system doing it.',
    '',
    `NEVER use these words: ${BANNED_WORDS}.`,
  )

  return lines.join('\n')
}

// The conversation as the model sees it. `driver` rows are the assistant.
//
// `images` (optional, base64 data URLs) turns the user turn into the
// OpenAI-compatible content-parts shape. aiClient passes `messages`
// through untouched, so vision rides the same request without the client
// knowing a picture exists. No images -> the plain string, as always.
export function buildMessages({ systemPrompt, history, newMessage, images }) {
  const userContent = Array.isArray(images) && images.length > 0
    ? [
        { type: 'text', text: newMessage },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : newMessage
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({
      role: m.role === 'driver' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: userContent },
  ]
}

export function trippedBannedWord(text) {
  const match = text.match(BANNED)
  return match ? match[0] : null
}

// A holding line, in character, for when a reply has to be thrown away. It
// says nothing about pay in either direction -- a fallback that took a side
// would put words in the driver's mouth that the money situation might not
// support.
export const FALLBACK_REPLY = 'Give me a minute, I am coming up on a scale.'

// Chain-of-thought leaking into the reply is fatal for a persona. Same
// tells as the broker prompt; observed live on 2026-08-31.
const REASONING_TELLS = [
  /^\s*(okay|ok|alright|so)[,:]?\s+(so\s+)?(the\s+)?(user|dispatcher|they)\b/i,
  /^\s*(here'?s|this is)\s+(my|a|the)?\s*(thinking|reasoning|thought|plan|approach)/i,
  /^\s*(let me|i need to|i should|we need to|we should|i'?ll need to)\s+(think|respond|answer|reply|consider|figure)/i,
  /^\s*the (user|driver|dispatcher) (is |wants|asked|says|has)/i,
  /^\s*we (need|have) to respond as\b/i,
  /^\s*<(think|thinking|reasoning)>/i,
  /^\s*\*\*?(thinking|reasoning|analysis)\*\*?/i,
]

export function leaksReasoning(text) {
  return REASONING_TELLS.some((re) => re.test(text))
}

// Exported so a test can assert every stage the payroll rules can produce
// has something to say. A stage with no stance would silently fall back to
// 'ok' -- a driver owed three weeks of pay chatting cheerfully about the
// weather.
export const STANCE_STAGES = Object.freeze(Object.keys(STANCE))
export { DRIVER_STAGES }

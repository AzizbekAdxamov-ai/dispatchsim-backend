// Chain-of-thought leaking into the reply is fatal for a persona: a person
// who narrates their own reasoning is obviously a machine. Observed live on
// 2026-08-31 -- nemotron-3-super-120b answered with 751 characters of
// "We need to respond as Devin Marlowe... We need to push back at least
// once..." instead of a reply -- and again on 2026-10-14 (EB02), when the
// reasoning came AFTER a plain-looking opening sentence.
//
// Two kinds of pattern. Anchored ones (^) are openings that are only a tell
// at the start: a broker can legitimately say "we need a reefer" mid-reply.
// The mid-reply ones are phrases nobody says to the person they are talking
// to ("what they're asking about", "I'd say something like"), so they are a
// tell anywhere.
//
// roleWord is the other side as the persona's prompt names it: 'carrier'
// for the broker chat, 'driver' for the driver chat.

import { asciiPunct } from './plainText.js'

function anchoredTells(roleWord) {
  const who = `(?:user|dispatcher|${roleWord})`
  // The two RegExp templates below use String.raw: in a plain template literal the
  // s-escape and the word-boundary escape lose their backslash.
  return [
    new RegExp(String.raw`^\s*(okay|ok|alright|so)[,:]?\s+(so\s+)?(the\s+)?(user|dispatcher|${roleWord}|they)\b`, 'i'),
    /^\s*(here'?s|this is)\s+(my|a|the)?\s*(thinking|reasoning|thought|plan|approach)/i,
    /^\s*(let me|i need to|i should|we need to|we should|i'?ll need to)\s+(think|respond|answer|reply|consider|figure)/i,
    new RegExp(String.raw`^\s*the ${who} (is |wants|asked|says|has)`, 'i'),
    /^\s*we (need|have) to respond as\b/i,
    /^\s*<(think|thinking|reasoning)>/i,
    /^\s*\*\*?(thinking|reasoning|analysis)\*\*?/i,
  ]
}

const MID_REPLY_TELLS = [
  // Live broker output narrated whether it should ask for email, then
  // appended an instruction to itself to stop responding.
  /\b(?:we need|i need|we should|i should) to ask for (?:an? )?e-?mail now\b/i,
  /\[\s*no further response needed\s*\]/i,
  /\bwhat (they'?re|they are|the (carrier|dispatcher|driver|user)( is)?) asking\b/i,
  /\bi'?d say something like\b/i,
  /\bi'?ll keep it (brief|short)\b/i,
  /\bi shouldn'?t volunteer\b/i,
]

export function leaksReasoning(text, { roleWord }) {
  const t = asciiPunct(text)
  return anchoredTells(roleWord).some((re) => re.test(t)) || MID_REPLY_TELLS.some((re) => re.test(t))
}

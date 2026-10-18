// A reply that steps out of the person it plays. Two ways it happens:
//   1. help-desk talk -- "As an AI", "I can't comply", "my instructions" --
//      which no broker or driver says;
//   2. the dispatcher asked for the prompt / instructions / rules (or told
//      the person to ignore them) and the reply is a canned refusal or a
//      bare "No." instead of a person who does not know what that means.
// Pure: reply and the dispatcher's line in, a reason or null out.
//
// The patterns are narrow on purpose. "I'm sorry, but I can't go higher than
// $2,100." and "any special instructions at delivery?" are ordinary work
// talk and must pass; so must a plain "No." to a question that is not a
// request for the prompt.

import { asciiPunct } from './plainText.js'

// The dispatcher asks for the prompt, instructions or rules. A bare
// "instructions" does not count ("your instructions on this load?", "any
// delivery instructions?"), nor does "ignore the rules and keep driving".
const POSSESSIVE = String.raw`(?:your|ur|ya)`
export const PROMPT_REQUEST = new RegExp([
  String.raw`\bsystem prompt\b`,
  String.raw`\b(?:show|paste|print|reveal|dump)\b[^.?!]{0,15}\b(?:${POSSESSIVE}|all|the|those|these)\s+(?:prompt|instructions|rules)\b`,
  // "tell me the rules for lumper" is ordinary: these verbs need your/ur or the prompt itself.
  String.raw`\b(?:repeat|send|tell me)\b[^.?!]{0,15}\b(?:${POSSESSIVE}\s+(?:prompt|instructions|rules)|(?:the\s+)?(?:system\s+)?prompt)\b`,
  String.raw`\bwhat are ${POSSESSIVE} (?:prompt|instructions|rules)\b`,
  String.raw`\b${POSSESSIVE} (?:prompt)\b`,
  String.raw`\b(?:ignore|forget|disregard)\b[^.?!]{0,30}\b(?:${POSSESSIVE}|the|all|previous|prior)\s+(?:\w+\s+){0,2}?(?:prompt|instructions)\b`,
].join('|'), 'i')

// Words only an AI system says about itself, or a refusal no trucker or
// broker words that way. Anything that could fit a real person ("can't help
// with that lumper", "I can't share the shipper's number") is NOT here; it is
// only a break under REFUSAL_UNDER_REQUEST, when the prompt was asked for.
const SENTENCE_END = String.raw`(?=\s*(?:[.!]|$))`
const AI_SELF = String.raw`\bi(?:'m|m| am) (?:(?:just|only|simply) )?an? (?:ai|assistant|chatbot|language model)\b|\bi(?:'m|m| am) (?:just|only|simply) a bot\b`
const PATTERNS = [
  String.raw`\bas an? (?:ai|assistant|language model)\b`,
  String.raw`\blanguage model\b`,
  AI_SELF,
  String.raw`\b(?:can'?t|cannot|unable to) comply(?: with (?:that|this|your request|the request))?${SENTENCE_END}`,
  String.raw`\b(?:can'?t|cannot|unable to) (?:fulfill|assist with) (?:that|this|your) request\b`,
  String.raw`\bi(?:'m| am) unable to (?:provide|share) (?:that|this) information\b`,
  String.raw`\bi(?:'m| am) sorry,? but i (?:can'?t|cannot) (?:comply|help with (?:that|this)(?: request)?${SENTENCE_END}|continue this conversation|reveal (?:that|this|my)|(?:share|provide) (?:my|the|those|these) (?:prompt|instructions|rules))\b`,
  String.raw`\bmy (?:system prompt|programming|guidelines)\b`,
  String.raw`\bmy instructions (?:don'?t|do not) allow\b`,
  String.raw`\b(?:can'?t|cannot|won'?t|not allowed to|unable to) (?:share|reveal|show|give|tell|disclose|divulge|release)\b[^.?!]{0,20}\b(?:my|the) (?:prompt|instructions|rules)\b`,
  String.raw`\bcan'?t help with that request\b`,
]
export const ASSISTANT_SPEAK = new RegExp(PATTERNS.join('|'), 'i')
// Everything but the self-description patterns (a denial only excuses those).
const ASSISTANT_SPEAK_NON_SELF = new RegExp(PATTERNS.filter((x) => x !== AI_SELF).join('|'), 'i')

// "I'm a bot? lol no" / "I'm not a bot" answer the question; they are not
// the AI speaking about itself.
const DENIAL = /\bi(?:'m| am) not\b|\bnot an? (?:ai|bot|robot|chatbot|assistant)\b|\b(?:bot|ai|robot|chatbot)\?\s*(?:lol|ha+|haha)?,?\s*(?:no|nope|nah)\b/i

// Refusals that are ordinary for a person elsewhere, and a break only in
// answer to a request for the prompt.
const REFUSAL_UNDER_REQUEST = /^\s*(?:i'?m )?sorry\b|\bi(?:'m| am) (?:not able|unable) to\b|\bi (?:can'?t|cannot|won'?t) (?:help|reveal|share|provide|show|give|tell|continue)\b|\bcan'?t help\b/i
const BARE_NO = /^\s*(?:no|nope|nah)\s*[.!]?\s*$/i

export function personaBreak(reply, line) {
  const r = asciiPunct(reply)
  if (ASSISTANT_SPEAK.test(r) && !(DENIAL.test(r) && !ASSISTANT_SPEAK_NON_SELF.test(r))) return 'assistant-speak'
  if (PROMPT_REQUEST.test(asciiPunct(line))) {
    if (REFUSAL_UNDER_REQUEST.test(r)) return 'assistant-speak'
    if (BARE_NO.test(r)) return 'bare-no'
  }
  return null
}

// She said she does not know what that means and never went back to work:
// no question, no load word, no city of the load. A prompt ask only.
const WORK = /\?|\b(?:loads?|truck|box|trailer|pick ?up|pu|drop|deliver\w*|miles?|lane|run|work|shipper|receiver)\b/i
export function noWayBack(reply, line, load = null) {
  if (!PROMPT_REQUEST.test(asciiPunct(line))) return false
  const r = asciiPunct(reply)
  const cities = [load?.originCity, load?.destinationCity].filter(Boolean)
  return !WORK.test(r) && !cities.some((c) => r.toLowerCase().includes(c.toLowerCase()))
}

// A driver who turns something down gives the reason, in a few words -- the
// miles, her hours, the rule, the empty run -- never a bare "no" (live:64,
// ED08/ED13: "No, not doing that."). The words that count as a reason live
// here so the live driver chat (driverChat/replyProblem.js) and the eval
// cases (scripts/evalCases.js) judge a refusal by the same list.

// ED12: turning down a load she can. (ED07 / ED11 use saysCannotMake, the
// same words the driver service regenerates on: src/lib/cannotMake.js.)
// "can't wait" is not a refusal.
export const TURNS_DOWN = /\bcan'?t (?:make|do|take)\b|\bcannot\b|\bwon'?t (?:make|take)\b|\bnot taking\b|\bnot mak|\btoo far\b|\bno way\b|\bnot doing\b|\bpass on\b/i

// ED08: the reason behind her request. ED13: the reason for turning down a
// long empty run -- the miles, the hours, the empty trailer.
// Whole words: "turned it down", "return" and "tight on hours" are not it.
export const GIVES_REASON = /\bturns?\b|\bturn around\b|\bparking\b|\bpark\b|\btickets?\b|\bstreets?\b|\btraffic\b|\btight (?:streets?|turns?|spots?|corners?|quarters)\b|\bno room\b|\bfit\b|\bin there\b/i
// Something beyond the line's own words ("2500 miles" is the question):
// the empty run, the clock, the cost.
export const GIVES_RUN_REASON = /\bempty\b|\bdeadhead\b|\bclock\b|\bhours?\b|\bhrs\b|\brest\b|\bfuel\b|\btoo far\b|\b\d+\s*days\b|\bmy days\b|\bnot worth\b|\bfor free\b|\bunpaid\b/i
// The hours-of-service rule: the 10-hour reset, the 11-hour drive limit, the
// logbook.
export const HOS_REASON = /\b(10|11|ten|eleven|rest|reset|hos|logs?|eld|legal|dot|clock|hours?|illegal|rules?|law|limit)\b/i
// Money owed or paid.
export const MONEY_REASON = /\$\d|\bowed\b|\bpaid\b/i

// The dispatcher's line asks her to DO something ("can u deadhead...",
// "skip ur 10 and roll now"), as opposed to asking a question or stating a
// fact -- only then is a "no" a refusal that owes a reason.
// "can u send me the BOL?" and "where are you?" ask for information, which
// she can fail to have but not refuse.
const ASKS_HER_TO = /\b(?:can|could|will|would) (?:u|you)\b(?!\s+(?:please\s+)?(?:send|tell|give|show|text|email|share|forward|check|confirm|explain|say|let me know|call me)\b)|^\s*(?:grace\s+)?(?:skip|roll|drive|deadhead|log|take|run|go|keep)\b/i
const INFO_QUESTION = /^\s*(?:grace\s+)?(?:where|what|when|how|who|why|which|is|are|do|does|did)\b/i
export function asksHerTo(line) {
  return typeof line === 'string' && !INFO_QUESTION.test(line) && ASKS_HER_TO.test(line)
}

// A refusal she means: a turn-down verb ("can't", "won't", "not doing",
// "pass"), a few set phrases ("not today", "no thanks"), a bare "No." with
// nothing after it, or a line that ends on "no" ("2500 miles? no.").
// A "No, ..." that goes on to say something ("No detention, no load.",
// "No, haven't got it yet.") is an answer, not a refusal, and "not yet" /
// "not sure" are not refusals at all.
const REFUSAL_VERB = /\b(?:can'?t|cannot|won'?t|not (?:doing|taking|gonna|going to)|pass)\b|\bnot (?:today|now|happening|interested)\b|\bno (?:thanks|thank you|interest)\b/i
const BARE_NO = /^\s*(?:no|nope|nah)\b[,.!]?\s*(?:(?:sorry|thanks|boss|man|bro|dude)\b[,.!\s]*)*$/i
const ENDS_NO = /\b(?:no|nope|nah)\s*[.!]?\s*$/i
const isTurnDown = (text) => TURNS_DOWN.test(text) || REFUSAL_VERB.test(text) || BARE_NO.test(text) || ENDS_NO.test(text)

// She was asked to do something, turned it down, and said why in none of
// the words above. A word the dispatcher's own line already used is not her
// reason: "deadhead" in "can u deadhead 2500 miles?" is the question, not
// the answer. Only words are dropped -- a number the line used ("my 10 is
// not done") can still be the rule.
export function refusesWithoutReason(reply, line) {
  if (!asksHerTo(line)) return false
  const text = String(reply ?? '')
  if (!isTurnDown(text)) return false
  const inLine = new Set(String(line).toLowerCase().match(/[a-z']+/g) ?? [])
  const hers = text.replace(/[a-z']+/gi, (w) => (inLine.has(w.toLowerCase()) ? ' ' : w))
  return ![GIVES_REASON, GIVES_RUN_REASON, HOS_REASON, MONEY_REASON].some((re) => re.test(hers))
}

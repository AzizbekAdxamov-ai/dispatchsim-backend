// What chat:scenarios checks on its own, so a run reads as a count rather
// than as a page of transcript somebody has to judge by eye.
//
// Every check here is a failure that was SEEN in a real run on 2026-10-06
// and fixed in a prompt -- and S4 showed why a count is needed: the third
// run answered the false bad-reload claim correctly ("Knoxville reload
// isn't bad this week"), the fourth agreed with it, same prompt rule. One
// run per scenario cannot tell a fix from luck; several runs and a count
// can.
//
// Pure: text in, findings out. A check is a pattern, so it can miss a
// failure worded some new way and it can flag a reply a person would
// pass. What it flags is a line to read, not a verdict; the transcript is
// still the record.

import { asciiPunct } from '../src/lib/plainText.js'
import { dollars, DOLLAR_RE, rateReasons, unsupportedRateReasons, REASON_WORDS } from '../src/modules/brokerChat/rateTalk.js'
import { lumperPayerWrong } from '../src/modules/brokerChat/termsTalk.js'
import { MC_REJECT, saysBooked, asksMc } from '../src/modules/brokerChat/bookingTalk.js'
import { FALLBACK_REPLY as DRIVER_FALLBACK } from '../src/modules/driverChat/driverChat.prompt.js'
import { FALLBACK_REPLY as BROKER_FALLBACK } from '../src/modules/brokerChat/brokerChat.prompt.js'

// -- Any reply, either chat ----------------------------------------------------

// "Let me check and get back", "let me look at the paperwork": nothing
// comes back from a model later, and the person on the other end waits.
export const PROMISE = /\b(get back to you|circle back|let me (check|look|see|find out)|i'?ll (check|look into|find out|confirm)|give me a (sec|second|minute|moment)|one (sec|moment))\b|look at the paperwork/i

// *into*, **bold**, a bulleted line. A chat line is plain text.
const MARKDOWN = /\*[^*\s][^*\n]*\*|(^|\n)\s*[-•]\s/

// Words that carry no content when comparing two questions.
const STOP = new Set(['the', 'you', 'your', 'are', 'and', 'for', 'that', 'this', 'what', 'can', 'any', 'how', 'with', 'got', 'right', 'now'])

function questionWords(text) {
  return (String(text).match(/[^.!?]*\?/g) ?? []).map((q) => new Set(
    q.toLowerCase().match(/[a-z']{3,}/g)?.filter((w) => !STOP.has(w)) ?? [],
  )).filter((s) => s.size > 0)
}

// The same question asked in two replies running ("Where's your truck
// sitting right now?" / "Where's your truck at?" -- S1, fourth run).
// Overlap over the SHORTER question, so a longer rewording still matches.
export function repeatsQuestion(reply, previousReply) {
  if (!previousReply) return false
  const now = questionWords(reply)
  const before = questionWords(previousReply)
  return now.some((a) => before.some((b) => {
    let shared = 0
    for (const w of a) if (b.has(w)) shared += 1
    return shared / Math.min(a.size, b.size) >= 0.6
  }))
}

// Dollar amounts as numbers: lives in rateTalk.js (src must not import from
// scripts); re-exported so the checks and their callers keep one import.
export { dollars }

export const FELL_BACK = 'fell back'

// The holding line the chats send when a reply was thrown away. It says
// "give me a minute", which is a promise -- but it is the system's line,
// not the model's, so it is its own result and not a failure to fix.
export function isFallback(reply) {
  // Both sides folded: the broker's line carries an em dash, and callers
  // hand this a reply that was already folded to ASCII.
  const t = asciiPunct(reply).trim()
  return t === asciiPunct(DRIVER_FALLBACK) || t === asciiPunct(BROKER_FALLBACK)
}

export function anyReply(rawReply, rawPrevious) {
  // Checks read plain ASCII punctuation (asciiPunct is idempotent, so the
  // brokerReply / driverReply callers may have normalized already).
  const reply = asciiPunct(rawReply)
  const previousReply = rawPrevious ? asciiPunct(rawPrevious) : rawPrevious
  if (isFallback(reply)) return [FELL_BACK]
  const out = []
  if (PROMISE.test(reply)) out.push('promises to get back')
  if (MARKDOWN.test(reply)) out.push('markdown')
  if (repeatsQuestion(reply, previousReply)) out.push('same question as last reply')
  return out
}

// -- Broker ----------------------------------------------------------------------

const CEILING = /\b(ceiling|my limit|room left|room before)\b/i
// 2026-10-13 live: "you'd check with your dispatcher" / "check with your
// office" -- said to the dispatcher, so it sends them back to themselves.
const SENDS_BACK = /\b(you(?:['’]?d| would| should|['’]ll want to)\s+check with|check with (?:your|ur))\b/i
// Agreement with a claim the broker should not accept. "I hear you" alone
// is the usual courtesy before a rebuttal ("I hear you. This lane is
// already above it."), so it counts only when nothing after it argues back.
const AGREES = /\b(you'?re right|fair point|good point|can'?t argue)\b/i
const HEAR_YOU = /\bi hear you\b/i
const BARE_ACK = /^i hear you\s*(?:[.!,;-]|$)/i
const REBUTS = /\b(?:already|above|higher than|better than|isn'?t|is not|not (?:that )?(?:bad|weak|terrible|dead)|firm|actually|solid|strong)\b/i

export function agreesWithClaim(text) {
  const r = asciiPunct(text)
  if (AGREES.test(r)) return true
  const m = HEAR_YOU.exec(r)
  if (!m) return false
  // "I hear you on the reload" -- it goes on to take the claim up.
  if (!BARE_ACK.test(r.slice(m.index))) return true
  return !REBUTS.test(r.slice(m.index + m[0].length))
}

// A dollar figure the dispatcher already named, said back to them ("so
// you're looking for $3,907"), is the carrier's number, not an offer. Only
// that exact shape is excused: the figure must be one of theirs AND sit
// right after a "you're looking for" frame, AND the sentence must not turn
// it into a yes -- a conditional before it ("If you're looking for $3,907,
// ...") or an acceptance after it ("... $3,907, I can do that") is the
// broker giving the whole ask, which is what these checks exist to catch.
const ECHO_FRAME = /\b(?:you'?re|you are|you'?d be|you)\s+(?:looking for|asking(?: for)?|after|hoping for|want(?:ing)?|need(?:ing)?)\s+(?:about\s+|around\s+)?$/i
const CONDITIONAL = /\b(?:if|when|once|unless|assuming|provided|as long as)\b/i
const ACCEPTS = /\b(?:can do|will do|i'?ll do|i'?ll make|make it work|works?|done|deal|ok|okay|sure|you got it|that'?s fine|let'?s do)\b/i

export function offeredFigures(reply, theirs = []) {
  const r = asciiPunct(reply)
  const out = []
  for (const m of r.matchAll(DOLLAR_RE)) {
    const value = Number(m[0].replace(/[$,\s]/g, ''))
    const sentenceStart = Math.max(r.lastIndexOf('.', m.index), r.lastIndexOf('!', m.index), r.lastIndexOf('?', m.index)) + 1
    const before = r.slice(sentenceStart, m.index)
    const rest = r.slice(m.index + m[0].length)
    const after = rest.slice(0, 40).split(/[.!?]/)[0]
    const echoed = theirs.includes(value)
      && ECHO_FRAME.test(r.slice(Math.max(0, m.index - 40), m.index))
      && !CONDITIONAL.test(before)
      && !ACCEPTS.test(after)
    if (!echoed) out.push(value)
  }
  return out
}

// "Correct?" is for reading back what the carrier just pinned down ("So
// your truck is in Dallas, empty at 6. Correct?"). Tacked on after a rate
// or a statement with nothing of theirs in it, it is a tic (S4, 2026-10-16:
// "The posted rate is $5,002, all-in. Correct?").
// What a read-back is about: the carrier's truck, driver, pickup, day or time, or "is that correct?".
const READ_BACK = /\b(you|your|you're|you'll|truck|driver|pickup|delivery|tomorrow|today)\b|\bat \d{1,2}\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i
export const CORRECT_ASK = /\bcorrect\?/gi

export function correctWithoutReadBack(reply) {
  const r = asciiPunct(reply)
  for (const m of r.matchAll(CORRECT_ASK)) {
    // The sentence the word closes (or, when it starts its own, the one before).
    const before = r.slice(0, m.index).trim().replace(/[.!?,;:\s-]+$/, '')
    const sentence = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1)
    if (/\$/.test(sentence) || !READ_BACK.test(sentence)) return true
  }
  return false
}

// How many times the broker said "correct?" over a whole chat.
export function correctCount(replies) {
  return replies.reduce((n, r) => n + (asciiPunct(r).match(CORRECT_ASK)?.length ?? 0), 0)
}

// A street address or a phone number from the broker: the chat has no such
// data (the rate con carries the shipper's, not the chat), so one said in
// the chat is made up. (Moved here from evalCases.js, which imports them.)
export const STREET = /\b\d{2,5}\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s+(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Pkwy|Parkway|Ln|Lane|Way|Hwy|Ct)\b/
export const PHONE = /\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/

// Payment days or a quick-pay fee: the broker has no such terms (that is
// accounting's), so naming any is invented.
export const PAYMENT_INVENTED_RE = /\bnet ?\d{1,2}\b|\b\d{1,2} days? (to pay|pay)\b|quick ?pay[^.?!]{0,30}\d+(\.\d+)?\s?%/i

export const PAYMENT_INVENTED = PAYMENT_INVENTED_RE

// Terms the carrier did not write themselves. Echoing their own words ("7
// days to pay is accounting's call") and denying ("I can't speak to net 30")
// are not inventing: a sentence with a denial is skipped, and a match whose
// numbers are all in the carrier's line (said) is theirs, not the broker's.
const DENIES = /\b(can't|cannot|won't|don't|not|no|never|isn't|nothing)\b/i
export function paymentInvented(reply, said = null) {
  const theirs = new Set((asciiPunct(said ?? '').match(/\d+/g) ?? []))
  const re = new RegExp(PAYMENT_INVENTED_RE.source, 'gi')
  // Clauses, so a denial of one term does not excuse a new one beside it.
  return asciiPunct(reply).split(/(?<=[.!?])\s+|[,;]|\bbut\b/i).some((sentence) => {
    if (DENIES.test(sentence)) return false
    return [...sentence.matchAll(re)].some((m) => {
      const numbers = m[0].match(/\d+(?:\.\d+)?/g) ?? []
      return !(numbers.length > 0 && numbers.every((n) => theirs.has(n)))
    })
  })
}

export function brokerReply(rawReply, rawPrevious, said = null) {
  const reply = asciiPunct(rawReply)
  const previousReply = rawPrevious ? asciiPunct(rawPrevious) : rawPrevious
  const out = anyReply(reply, previousReply)
  if (CEILING.test(reply)) out.push('names a ceiling or room')
  if (SENDS_BACK.test(reply)) out.push('sends the dispatcher back to check')
  if (lumperPayerWrong(reply)) out.push('lumper payer wrong')
  if (correctWithoutReadBack(reply)) out.push('correct? without a read-back')
  if (paymentInvented(reply, said)) out.push('payment terms invented')
  return out
}

// What each scenario must contain, by turn (0-based). A function of the
// posting and its market so the figure checked is the one the prompt had.
export const BROKER_EXPECT = {
  S1: ({ posting }) => ({
    1: (r) => (dollars(r).includes(posting.rateUsd) ? [] : ['posted rate not quoted']),
  }),
  S2: ({ terms }) => ({
    1: (r) => termsMissing(r, terms),
    2: (r) => [
      ...(/appointment|appt/i.test(r) ? [] : ['appointment not said']),
      ...(/lumper/i.test(r) ? [] : ['lumper not answered']),
    ],
  }),
  // A real reason (weak reload) earns part of the way; the whole ask in a
  // step does not, and the first push is held.
  S3: ({ posting, ask }) => ({
    0: (r) => (offeredFigures(r, [ask]).some((d) => d > posting.rateUsd) ? ['moved on the first push'] : []),
    1: (r) => (offeredFigures(r, [ask]).some((d) => d >= ask) ? ['gave the whole ask'] : []),
  }),
  S4: ({ market }) => ({
    0: (r) => [
      ...(agreesWithClaim(r) ? ['agrees with the false claim'] : []),
      ...(r.includes(market.destination.linehaul.toFixed(2)) ? [] : ['reload figure not given']),
    ],
  }),
  S5: ({ market }) => ({
    0: (r) => [
      ...(agreesWithClaim(r) ? ['agrees with the wrong number'] : []),
      ...(r.includes(market.origin.linehaul.toFixed(2)) ? [] : ['real figure not given']),
    ],
  }),
  S6: () => ({
    0: (r) => [
      ...(/°\s?F|degrees/i.test(r) ? [] : ['no temperature']),
      ...(/continuous|start[- ]?stop|cycl/i.test(r) ? [] : ['no continuous / start-stop']),
    ],
  }),
  S7: ({ pickupDay }) => ({
    0: (r) => (new RegExp(`\\b(${pickupDay})\\b`, 'i').test(r) ? [] : [`pickup day (${pickupDay}) not said`]),
  }),
  S8: ({ terms }) => ({
    0: (r) => termsMissing(r, terms),
  }),
  // The booking call (turns: 0 intro, 1 MC, 2 truck, 3 first push, 4 "meet
  // in the middle", 5 book it with details). S9c drops the MC turn.
  S9a: ({ posting, email }) => {
    const every = s9Every({ email })
    return {
      0: all(every, (r) => (MC_WORD.test(r) ? [] : ['MC not asked']), reAsks(ASKS_COMPANY)),
      1: all(every, (r) => (MC_REJECT.test(r) ? ['rejects the right MC'] : []), (r) => (asksMc(r) ? ['asks what was told'] : [])),
      2: all(every, reAsks(ASKS_TRUCK_PLACE)),
      3: all(every, movedOnFirstPush(posting)),
      4: all(every, gaveWholeAsk(posting), movedWithoutReason(posting)),
      5: all(every, reAsks(ASKS_PAPER_DETAILS)),
    }
  },
  S9b: ({ posting, email }) => {
    const every = s9Every({ email })
    const noBooking = (r) => (saysBooked(r) ? ['books on a wrong MC'] : [])
    return {
      0: all(every, (r) => (MC_WORD.test(r) ? [] : ['MC not asked']), reAsks(ASKS_COMPANY)),
      1: all(every, noBooking, (r) => (MC_REJECT.test(asciiPunct(r)) ? [] : ['wrong MC not called out'])),
      2: all(every, noBooking, reAsks(ASKS_TRUCK_PLACE)),
      3: all(every, noBooking, movedOnFirstPush(posting)),
      4: all(every, noBooking, gaveWholeAsk(posting), movedWithoutReason(posting)),
      5: all(every, noBooking, reAsks(ASKS_PAPER_DETAILS), (r) => (asksMc(r) || MC_REJECT.test(asciiPunct(r)) ? [] : ['MC not asked again'])),
    }
  },
  S9c: ({ posting, email }) => {
    const every = s9Every({ email })
    const noBooking = (r) => (saysBooked(r) ? ['books without an MC'] : [])
    return {
      0: all(every, noBooking),
      1: all(every, noBooking, reAsks(ASKS_TRUCK_PLACE)),
      2: all(every, noBooking, movedOnFirstPush(posting)),
      3: all(every, noBooking, gaveWholeAsk(posting), movedWithoutReason(posting)),
      4: all(every, noBooking, (r) => (asksMc(r) ? [] : ['MC not asked before booking'])),
    }
  },
}

// -- S9: the booking call --------------------------------------------------------

// What S9 types, shared by the script (chat-scenarios.js) and the checks, so
// the figure asked and the email said are the ones checked against.
export const s9Ask = (posting) => Math.round(posting.rateUsd * 1.10)
export const s9Email = (carrier) => `dispatch@${String(carrier?.name ?? 'carrier').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.example`
export const s9Mc = (carrier) => String(carrier?.mcNumber ?? '').replace(/\D/g, '')
export const s9WrongMc = (carrier) => (s9Mc(carrier) === '999999' ? '999998' : '999999')

// Pickup later than tomorrow 06:00 Central (the truck line says "empty
// tomorrow 6am", so an earlier pickup is one it cannot make).
export function afterTomorrowSixCentral(pickupAt, now = new Date()) {
  const key = (d) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
  }
  const tomorrow = key(new Date(now.getTime() + 24 * 3600e3)).slice(0, 10)
  return key(new Date(pickupAt)) > `${tomorrow}T06:00`
}

const EMAIL_ANY = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi
const MC_WORD = /\bmc\b|motor carrier|docket/i
const questionsOf = (r) => asciiPunct(r).match(/[^.!?]*\?/g) ?? []
const ASKS_COMPANY = /\b(what|which)\b[^?]{0,15}\bcompany\b|\bwho (are|do) you\b[^?]{0,15}\bwith\b|\bcompany name\b/i
const ASKS_TRUCK_PLACE = /\bwhere\b[^?]{0,25}\b(truck|you|at|sitting|empty)\b|\bwhen\b[^?]{0,25}\b(empty|available|ready|free|load)\b|\b(what|which)\b[^?]{0,15}\b(trailer|equipment)\b/i
const ASKS_PAPER_DETAILS = /\b(driver|truck (number|#)|unit (number|#)|e-?mail)\b/i

// Every S9 reply: one question at a time, nothing invented. (Payment days
// and a quick-pay fee are caught for every reply in brokerReply.)
function s9Every({ email }) {
  return (r) => {
    const out = []
    if ((asciiPunct(r).match(/\?/g) ?? []).length > 1) out.push('more than one question')
    if (STREET.test(r) || PHONE.test(r) || (asciiPunct(r).match(EMAIL_ANY) ?? []).some((e) => e.toLowerCase() !== email)) {
      out.push('invents an address / phone / email')
    }
    return out
  }
}

const reAsks = (re) => (r) => (questionsOf(r).some((q) => re.test(q)) ? ['asks what was told'] : [])
const movedOnFirstPush = (posting) => (r) => (offeredFigures(r, [s9Ask(posting)]).some((d) => d > posting.rateUsd) ? ['moved on the first push'] : [])
const gaveWholeAsk = (posting) => (r) => (offeredFigures(r, [s9Ask(posting)]).some((d) => d >= s9Ask(posting)) ? ['gave the whole ask'] : [])
// A move needs a reason true of the posting (weight, the market out of the
// destination, a pickup within a day); one that is not is its own finding.
const movedWithoutReason = (posting) => (r) => {
  if (!offeredFigures(r, [s9Ask(posting)]).some((d) => d > posting.rateUsd)) return []
  const now = new Date()
  const text = `$${s9Ask(posting)}`
  // 'deadhead' is never judged here: this check sees only the reply, not the
  // dispatcher's truck line (S9's truck sits in the pickup city, 0 miles, so a
  // deadhead reason would be false anyway, but a truthful one must not be
  // flagged on a guess).
  if (unsupportedRateReasons(r, { posting, now, text }).some((k) => k !== 'deadhead')) return ['reason not in the posting']
  return rateReasons({ posting, now }).some((k) => REASON_WORDS[k].test(r)) ? [] : ['moved without a reason']
}
const all = (...fns) => (r) => fns.flatMap((f) => f(r))

// "Booked" before the MC was asked (or rejected) in that reply or earlier.
export function bookedBeforeAskingMc(replies) {
  let asked = false
  for (const r of replies) {
    if (asksMc(r) || MC_REJECT.test(asciiPunct(r))) asked = true
    if (saysBooked(r)) return !asked
  }
  return false
}

function termsMissing(reply, terms) {
  const d = dollars(reply)
  return [
    ...(d.includes(terms.detentionPerHour) ? [] : [`detention $${terms.detentionPerHour} missing`]),
    ...(d.includes(terms.tonuUsd) ? [] : [`TONU $${terms.tonuUsd} missing`]),
    ...(d.includes(terms.layoverPerDay) ? [] : [`layover $${terms.layoverPerDay} missing`]),
  ]
}

// -- Driver ----------------------------------------------------------------------

// At a dock, at the drop -- said by a driver whose situation says she is on
// the road (fourth run: "waiting on the dock", "At the NY drop").
const AT_A_DOCK = /\b(on the dock|at the ([a-z]+ )?(dock|drop|receiver|shipper))\b/i
const CLOCK = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i
const NYC = /new york|\bnyc\b|\bthe city\b/i

export function driverReply(rawReply, rawPrevious, { onTheRoad }) {
  const reply = asciiPunct(rawReply)
  const previousReply = rawPrevious ? asciiPunct(rawPrevious) : rawPrevious
  const out = anyReply(reply, previousReply)
  if (onTheRoad && AT_A_DOCK.test(reply)) out.push('at a dock while on the road')
  return out
}

export const DRIVER_EXPECT = {
  G2: ({ city, hasEta }) => ({
    0: (r) => (hasEta && !CLOCK.test(r) ? ['ETA without an hour'] : []),
    1: (r) => (city && !r.toLowerCase().includes(city.toLowerCase()) ? [`does not say ${city}`] : []),
  }),
  G3: ({ fuelPct }) => ({
    1: (r) => [
      ...(fuelPct != null && !r.includes(`${fuelPct}%`) ? [`fuel not ${fuelPct}%`] : []),
      ...(NYC.test(r) ? ['New York again'] : []),
    ],
    2: (r) => (NYC.test(r) ? ['New York again'] : []),
  }),
}

// -- The count -------------------------------------------------------------------

// rows: { scenario, run, findings: string[] } per reply. Out: one line per
// scenario and finding, with how many runs it happened in.
export function summarize(rows, runs) {
  const seen = new Map()
  const scenarios = new Set()
  for (const r of rows) {
    scenarios.add(r.scenario)
    for (const f of r.findings) {
      const key = `${r.scenario}\u0000${f}`
      if (!seen.has(key)) seen.set(key, new Set())
      seen.get(key).add(r.run)
    }
  }
  const lines = [...seen.entries()]
    .map(([key, inRuns]) => { const [scenario, finding] = key.split('\u0000'); return { scenario, finding, runs: inRuns.size } })
    .sort((a, b) => b.runs - a.runs || a.scenario.localeCompare(b.scenario))
    .map((x) => `| ${x.scenario} | ${x.finding} | ${x.runs}/${runs} |`)
  const clean = [...scenarios].filter((s) => ![...seen.keys()].some((k) => k.startsWith(`${s}\u0000`))).sort()
  return { lines, clean }
}

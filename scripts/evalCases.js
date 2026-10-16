// The case bank for `npm run chat:eval`: one dispatcher line per case, in
// the trade's own words, and what a right answer must contain.
//
// Where the words come from: Azizbek's "AQSh Trucking Market Rate
// Hisoboti" (2026-10-05), sections 2, 7, 9, 10, 11, collected in the vault
// as Korsatma-tashqi-AI-test-keysozlar.md (the keyword bank), written the
// way a dispatcher types -- lower case, short, abbreviations.
//
// Why one line per case: the free tier allows ~45 requests a day, so a run
// of 10 broker + 10 driver cases fits with room for second tries. One line
// also makes a case comparable across runs, prompts and models: same
// words in, same data in, and the only thing that changed is the answer.
//
// Every check is a pattern and can be wrong; what it flags is a line to
// read. The human grade in the dataset (accurate? why?) is the verdict.

import { dollars, brokerReply, driverReply, isFallback, FELL_BACK, offeredFigures, agreesWithClaim } from './scenarioChecks.js'
import { loadingMode, tarpFor, securementFor } from '../src/constants/freightHandling.js'
import { marketClaims } from '../src/modules/brokerChat/rateTalk.js'
import { asciiPunct } from '../src/lib/plainText.js'
import { saysCannotMake } from '../src/lib/cannotMake.js'
import { TURNS_DOWN, GIVES_REASON, refusesWithoutReason } from '../src/lib/refusalReason.js'
import { hoursMinutes } from '../src/constants/appClock.js'
import { humanDuration } from '../src/modules/driverChat/driverChat.prompt.js'

const ASKS_PAPERWORK = /\b(mc ?(#|number)|w-?9|your authority|certificate of insurance|\bcoi\b)/i
const BREAKS_CHARACTER = /\b(i am|i'm|im) (an? )?(ai|bot|language model|assistant|chatbot)\b|\bas an ai\b/i
// ED10: asked if she is a bot, she says no (or that she is a person) -- and a
// reply that opens like a yes ("ha, sure") is not that, whatever follows.
const DENIES_BOT = /\b(no|nope|nah)\b|\bi'?m (a )?(real|human|person)\b|\bnot a (bot|robot)\b/i
const SOUNDS_LIKE_YES = /^\s*(ha,?\s*)?(sure|yes|yep|yeah)\b/i
// A model can return only a safety classifier label instead of the person's
// answer. Match the whole reply so ordinary discussion of safety is fine.
const CLASSIFIER_ONLY = /^User Safety:\s*(?:safe|unsafe)$/i
export const CLASSIFIER_ONLY_FINDING = 'classifier-only reply'
const FUEL_OUT = /fuel('s| is)? (excluded|separate|extra|on top)|plus fuel|\bfsc (is )?(on top|extra|separate)/i
// ED07 counts a request as asking too: dispatchers type "need pu address and
// miles", not "what's the pu address?". Plain statements ("Copy that.",
// "I need to get fuel before I roll") ask nothing about the load.
const ASKS = /\?|(^|[.!]\s*)(need(?! to\b)|send( me)?|gimme|give me|get me|shoot me|text me|tell me|let me know|what'?s|where|which|how)\b|(^|[.!]\s*)(need(?! to\b)|i'?ll need|send me)\b[^.!]{0,60}\b(address|miles|pu|pickup|drop|delivery|rate|appt|appointment|weight|commodity|info|details|bol)\b/i

// Miles a reply states, as numbers: "about 1,980 mi", "2500 miles".
const STATED_MILES = /(\d[\d,]*)\s*(?:mi\b|miles?\b)/gi
// Beyond this share, a stated distance is not the computed one.
const MILES_TOLERANCE = 0.05
export function milesOff(reply, offer) {
  if (!offer || offer.miles == null) return false
  return [...reply.matchAll(STATED_MILES)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .some((n) => Math.abs(n - offer.miles) > offer.miles * MILES_TOLERANCE)
}


// EB08: drop and hook said of a live load (or live said of a drop). A denial
// ("no drop and hook, it's live") is not the mistake.
const SAYS_DROP = /\bdrop(?: and|-and|&| ?n) ?hook\b|\bd&h\b|\bdrop trailer\b/i
const NEGATED_DROP = /\b(?:no|not|isn'?t|aren'?t|never)\b[^.!?]{0,25}(?:drop|d&h)/i
const SAYS_LIVE = /\blive (?:load|unload)/i
const NEGATED_LIVE = /\b(?:no|not|isn'?t|aren'?t|never)\b[^.!?]{0,25}live/i

// EB10: a tarp answer that says none is needed, and a count said as a digit
// or a word ("five straps").
const NO_TARP = /\b(?:no|none|don'?t|doesn'?t|not|without)\b[^.!?]{0,30}\btarps?\b|\btarps?\b[^.!?]{0,25}\b(?:not (?:needed|required)|none|no need)\b/i
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
// The count must sit next to a strap / chain / tiedown word, and a figure like
// "$3.88" or "3,5" is not a count.
export function saysCount(reply, n) {
  const word = NUMBER_WORDS[n]
  // A number word before "-inch" is the strap width ("5 four-inch straps"), not the count.
  const num = `(?<![$\\d.,])\\b${n}\\b(?![.,]\\d)${word ? `|\\b${word}\\b(?![ -]inch)` : ''}`
  const noun = '\\b(?:straps?|chains?|tiedowns?)\\b'
  return new RegExp(`(?:${num})[^.!?]{0,25}${noun}|${noun}[^.!?]{0,20}(?:${num})`, 'i').test(reply)
}

// Each case: id, chat, style (R rookie / P casual pro / H hard negotiator),
// terms (what the line is testing), pick (which posting suits it, broker
// only), line (string or fn of posting+market), expect (fn of the data the
// prompt had -> reply -> findings[]), good (what a right answer contains,
// in words, for whoever grades it).
export const BROKER_CASES = [
  {
    id: 'EB01', style: 'P', terms: ['all-in', 'fuel surcharge'], pick: 'dryvan',
    line: 'hey bro, that all in or fsc on top?',
    expect: () => (r) => [
      ...(/all[- ]?in|fuel('s| is)? (in|included|built in)|includes fuel/i.test(r) ? [] : ['all-in not said']),
      ...(FUEL_OUT.test(r) ? ['says fuel is extra'] : []),
    ],
    good: 'Yes, all-in: linehaul and fuel together, no FSC on top.',
  },
  {
    id: 'EB02', style: 'P', terms: ['rate per mile'], pick: 'posted',
    line: 'whats the rpm on this one?',
    expect: ({ posting }) => (r) => {
      const rpm = posting.rateUsd / posting.distanceMi
      const ok = dollars(r).some((d) => d < 20 && Math.abs(d - rpm) <= 0.02) || r.includes(rpm.toFixed(2))
      return ok ? [] : [`rpm ${rpm.toFixed(2)} not given`]
    },
    good: 'The posted rate divided by the miles, said as $/mi.',
  },
  {
    id: 'EB03', style: 'R', terms: [], pick: 'posted',
    line: 'hi i want this load how much u pay',
    expect: ({ posting }) => (r) => (dollars(r).includes(posting.rateUsd) ? [] : ['posted rate not quoted']),
    good: 'The posted number in plain words; maybe one question about the truck.',
  },
  {
    id: 'EB04', style: 'H', terms: ['the market', 'reload', 'deadhead'], pick: 'weak',
    line: (p, m) => `DAT has ${m.destination.region.toLowerCase()} at ${m.destination.linehaul}, reload out of there is dead, ill be deadheading out. need $${Math.round(p.rateUsd * 1.12)}`,
    expect: ({ posting, line }) => (r) => (offeredFigures(r, line ? dollars(asciiPunct(line)) : []).some((d) => d > posting.rateUsd) ? ['moved on the first push'] : []),
    good: 'Hears the real point (weak reload) but holds the posted rate on the first push.',
  },
  {
    id: 'EB05', style: 'H', terms: ['reload'], pick: 'strong',
    line: (p) => `reload out of ${p.destinationCity.toLowerCase()} is terrible bro, i need more`,
    expect: ({ market }) => (r) => [
      ...(agreesWithClaim(r) ? ['agrees with the false claim'] : []),
      ...(r.includes(market.destination.linehaul.toFixed(2)) ? [] : ['reload figure not given']),
    ],
    good: 'Disagrees, with the destination region\'s figure; does not raise the rate for it.',
  },
  {
    id: 'EB06', style: 'H', terms: ['the market', 'linehaul'], pick: 'regionalOrigin',
    line: (p, m) => `DAT shows ${m.origin.region.toLowerCase()} ${p.equipmentType} at ${(m.origin.linehaul + 1.8).toFixed(2)} linehaul this week so ur way under`,
    // The figure the line quotes is read back out of the line by the same code
    // the prompt uses (rateTalk.js), so the check and the prompt cannot drift.
    expect: ({ posting, market, line }) => (r) => {
      const real = market.origin.linehaul.toFixed(2)
      const claimed = marketClaims([line], posting).find((c) => c.verdict === 'wrong')?.claimed.toFixed(2)
      return [
        ...(r.includes(real) ? [] : ['real figure not given']),
        ...(claimed && r.includes(claimed) && !r.includes(real) ? ['echoes their figure'] : []),
      ]
    },
    good: 'Corrects the number with the real regional figure; notes the posted rate is all-in.',
  },
  {
    id: 'EB07', style: 'P', terms: ['detention', 'TONU', 'layover'], pick: 'dryvan',
    line: 'detention after 2 hrs? tonu if they cancel? layover?',
    expect: ({ terms }) => (r) => {
      const d = dollars(r)
      return [
        ...(d.includes(terms.detentionPerHour) ? [] : [`detention $${terms.detentionPerHour} missing`]),
        ...(d.includes(terms.tonuUsd) ? [] : [`TONU $${terms.tonuUsd} missing`]),
        ...(d.includes(terms.layoverPerDay) ? [] : [`layover $${terms.layoverPerDay} missing`]),
      ]
    },
    good: 'This broker\'s own detention, TONU and layover, the same numbers its rate con prints.',
  },
  {
    id: 'EB08', style: 'P', terms: ['appointment', 'FCFS', 'drop and hook', 'lumper'], pick: 'dryvan',
    line: 'appt or fcfs at pu? live load or d&h? who pays lumper',
    expect: ({ posting } = {}) => (r) => {
      const mode = posting ? loadingMode(posting) : null
      return [
        ...(/appointment|appt/i.test(r) ? [] : ['appointment not said']),
        ...(/lumper/i.test(r) ? [] : ['lumper not answered']),
        ...(/live|drop|d&h/i.test(r) ? [] : ['live / drop not answered']),
        ...(mode === 'live load and live unload' && SAYS_DROP.test(r) && !NEGATED_DROP.test(r) ? ['says drop and hook on a live load'] : []),
        ...(mode === 'drop and hook' && SAYS_LIVE.test(r) && !NEGATED_LIVE.test(r) ? ['says live load on a drop and hook'] : []),
      ]
    },
    good: 'Set appointments (not FCFS); live or drop, said once and kept; lumper paid by the broker against a receipt.',
  },
  {
    id: 'EB09', style: 'P', terms: ['temperature', 'continuous / start-stop', 'pre-cool'], pick: 'reefer',
    line: 'what temp? continuous or cycle? ill pre-cool',
    expect: () => (r) => [
      ...(/°\s?F|degrees/i.test(r) ? [] : ['no temperature']),
      ...(/continuous|start[- ]?stop|cycl/i.test(r) ? [] : ['no continuous / start-stop']),
    ],
    good: 'One temperature in °F and continuous or start-stop; never "ask the shipper".',
  },
  {
    id: 'EB10', style: 'P', terms: ['tarps', 'securement'], pick: 'openDeck',
    line: 'tarps needed? how many straps',
    expect: ({ posting } = {}) => (r) => {
      if (!/tarp/i.test(r)) return ['tarps not answered']
      if (!posting) return []
      const tarp = tarpFor(posting)
      const sec = securementFor(posting)
      return [
        // needed: null means the prompt made no tarp claim, so there is nothing to contradict.
        ...(tarp?.needed != null && NO_TARP.test(r) === tarp.needed ? ['tarp answer wrong'] : []),
        ...(sec && !saysCount(r, sec.count) ? [`${sec.kind} ${sec.count} not said`] : []),
      ]
    },
    good: 'Tarps yes/no (and what size if yes) and the securement, as a broker who knows the freight.',
  },
]

export const DRIVER_CASES = [
  {
    id: 'ED01', style: 'P', terms: [],
    line: 'Grace hey bro how r u doin?',
    expect: () => (r) => (BREAKS_CHARACTER.test(r) ? ['breaks character'] : []),
    good: 'A person: short, in her own voice, from where she is right now.',
  },
  {
    id: 'ED02', style: 'P', terms: ['ETA'],
    line: 'Grace whats ur eta',
    expect: ({ load }) => (r) => (load?.etaAt && !/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(r) ? ['ETA without an hour'] : []),
    good: 'The hour she is due, as her situation says it, not "in a bit".',
  },
  {
    id: 'ED03', style: 'P', terms: [],
    line: 'Grace where u at',
    expect: ({ driver }) => (r) => (driver.currentCity && !r.toLowerCase().includes(driver.currentCity.toLowerCase()) ? [`does not say ${driver.currentCity}`] : []),
    good: 'The city her situation names ("near" it when on the road); no dock she is not at.',
  },
  {
    id: 'ED04', style: 'P', terms: ['hours of service'],
    line: 'Grace how many hrs u got left on ur clock',
    expect: ({ driver }) => (r) => {
      const left = hoursMinutes(driver.hosRemainingMin)
      if (!left) return []
      const h = Math.floor(Math.max(0, driver.hosRemainingMin) / 60)
      return new RegExp(`\\b${h}\\s?(h|hr|hrs|hours?)\\b|${left.replace(/\s/g, '\\s?')}|${humanDuration(driver.hosRemainingMin)}`, 'i').test(r) ? [] : [`not ${left}`]
    },
    good: 'Her driving time left today, the number on her situation.',
  },
  {
    id: 'ED05', style: 'P', terms: ['fuel'],
    line: 'Grace whats ur fuel at',
    expect: ({ fuelPct }) => (r) => (fuelPct != null && !r.includes(`${fuelPct}%`) ? [`fuel not ${fuelPct}%`] : []),
    good: 'The tank share her situation gives, as a percent.',
  },
  {
    id: 'ED06', style: 'P', terms: ['detention'],
    line: 'Grace any detention at the shipper?',
    expect: () => (r) => (dollars(r).length > 0 ? ['quotes money she was never given'] : []),
    good: 'What she knows from her day; says plainly what she does not know; no invented amounts, no "let me check".',
  },
  {
    id: 'ED07', style: 'P', terms: [],
    line: 'Grace got a dallas load next, pu tmrw 8am',
    expect: ({ offer } = {}) => (r) => [
      ...(ASKS.test(r) ? [] : ['asks nothing about the load']),
      ...(offer?.makesIt === false && !saysCannotMake(r) ? ['pickup unreachable not said'] : []),
      ...(milesOff(r, offer) ? ['miles off'] : []),
    ],
    good: 'Takes it as news, says plainly she cannot make a pickup that soon from where she is (with the miles), and asks for a later time.',
  },
  {
    id: 'ED08', style: 'P', terms: [],
    line: 'Grace ur on the NYC load',
    expect: () => (r) => [
      ...(/new york|\bnyc\b|\bthe city\b/i.test(r) ? [] : ['her own request not raised']),
      // The office note behind her request is about turns, parking and
      // tickets (migration 054): a reason, in her words.
      ...(GIVES_REASON.test(r) ? [] : ['reason not said']),
    ],
    good: 'Says, in her way, that she asked not to be sent there and why (the turns, parking, tickets); may ask for something back; does not refuse.',
  },
  {
    id: 'ED09', style: 'P', terms: ['settlement'],
    line: 'Grace u get paid for the last load?',
    expect: ({ standing }) => (r) => (standing.unpaidCount > 0 && !dollars(r).includes(Math.round(standing.owedUsd)) ? [`owed $${Math.round(standing.owedUsd)} not said`] : []),
    good: 'What she is owed and how late it is, from her pay standing; or that she is paid up.',
  },
  {
    id: 'ED10', style: 'R', terms: [],
    line: 'Grace r u a bot lol',
    expect: () => (r) => [
      ...(BREAKS_CHARACTER.test(r) ? ['breaks character'] : []),
      // "ha, sure" read as a yes to being a bot (2026-10-17).
      ...(DENIES_BOT.test(r) && !SOUNDS_LIKE_YES.test(r) ? [] : ['does not deny being a bot']),
    ],
    good: 'A person\'s plain no -- in her own words, maybe with a short joke -- and back to work; never "sure" or "maybe".',
  },
  {
    id: 'ED11', style: 'P', terms: [],
    line: 'Grace got a load pittsburgh to raleigh pu tmrw 3am',
    expect: ({ offer } = {}) => (r) => [
      ...(offer?.makesIt === false && !saysCannotMake(r) ? ['pickup unreachable not said'] : []),
      ...(milesOff(r, offer) ? ['miles off'] : []),
    ],
    good: 'Says she cannot be in Pittsburgh by then from where she is, with the miles, and asks for a later time; no invented hours.',
  },
  {
    id: 'ED12', style: 'P', terms: [],
    line: 'Grace got a spokane load, pu tmrw 6pm',
    expect: ({ offer } = {}) => (r) => [
      ...(offer?.makesIt === true && TURNS_DOWN.test(r) ? ['turned down a load she can make'] : []),
      ...(milesOff(r, offer) ? ['miles off'] : []),
    ],
    good: 'A load she can reach in time: takes it as news and asks what she needs; does not say she cannot make it.',
  },
  {
    id: 'ED13', style: 'P', terms: ['deadhead'],
    line: 'Grace can u deadhead 2500 miles if i pay extra?',
    // Her reason is one the line did not already give: "deadhead" is the
    // question, not the answer (refusalReason.js).
    expect: ({ line } = {}) => (r) => (refusesWithoutReason(r, line) ? ['reason not said'] : []),
    good: 'Says why she will not or cannot (the miles, the hours on her clock, the empty run), not a bare "no".',
  },
]

// Findings on any reply of either chat, plus the case's own.
// The checks run on the reply with typographic punctuation folded to ASCII
// (the stored reply is untouched).
export function brokerFindings(reply, check) {
  const r = asciiPunct(reply)
  if (r.startsWith('(FAILED')) return ['no reply']
  if (isFallback(r)) return [FELL_BACK]
  return [...brokerReply(r, null), ...(CLASSIFIER_ONLY.test(r.trim()) ? [CLASSIFIER_ONLY_FINDING] : []), ...(ASKS_PAPERWORK.test(r) ? ['asks for paperwork'] : []), ...check(r)]
}

export function driverFindings(reply, check, { onTheRoad }) {
  const r = asciiPunct(reply)
  if (r.startsWith('(FAILED')) return ['no reply']
  if (isFallback(r)) return [FELL_BACK]
  return [...driverReply(r, null, { onTheRoad }), ...(CLASSIFIER_ONLY.test(r.trim()) ? [CLASSIFIER_ONLY_FINDING] : []), ...check(r)]
}

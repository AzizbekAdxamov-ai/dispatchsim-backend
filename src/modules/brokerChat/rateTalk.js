// What the dispatcher has said about the market and about the rate, read by
// code instead of left to the model.
//
// Two live failures (chat:eval, 2026-10-14):
//   EB06  "DAT shows carolinas flatbed at 4.75 linehaul this week so ur way
//         under" -> the broker answered "yeah, the Carolinas are up around
//         $4.75/mi". DAT's Carolinas flatbed linehaul is $2.95. The prompt
//         said only "if they quote numbers that are wrong, say so", which
//         left it to the model to find the region, the equipment and the
//         right figure -- and it agreed instead.
//   EB04  a first push ("need $4278") was met with $3820 -> $4100, because
//         the weak-reload text said "move for it" while ON RATE said "hold
//         on the first push".
// Here the claim is checked against src/constants/marketRates.js and the
// pushes are counted; the prompt is then TOLD the result as a fact.
//
// Pure: text in, facts out. No clock, no network, no database.

import { asciiPunct } from '../../lib/plainText.js'
import {
  REGION_STATES, REGIONAL_LINEHAUL, NATIONAL_LINEHAUL, DB_RPM_MAX, fuelPerMile, marketFacts,
} from '../../constants/marketRates.js'

// Dollar amounts as numbers: "$3,750" and "$3750" are the same figure.
// (Moved here from scripts/scenarioChecks.js so src does not depend on
// scripts; scenarioChecks imports it from here.)
export const DOLLAR_RE = /\$\s?\d[\d,]*(\.\d+)?/g
export function dollars(text) {
  return (String(text).match(DOLLAR_RE) ?? []).map((d) => Number(d.replace(/[$,\s]/g, '')))
}

// A dollar figure the dispatcher already named, said back to them ("so
// you're looking for $3,907"), is the carrier's number, not an offer. Only
// that exact shape is excused: the figure must be one of theirs AND sit
// right after a "you're looking for" frame, AND the sentence must not turn
// it into a yes -- a conditional before it ("If you're looking for $3,907,
// ...") or an acceptance after it ("... $3,907, I can do that") is the
// broker giving the whole ask, which is what these checks exist to catch.
// (Moved here from scripts/scenarioChecks.js, which re-exports it.)
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

// -- The market claim -------------------------------------------------------

const NATIONAL = 'National'

// How a dispatcher writes each region. The generic pattern comes from the
// REGION_STATES key itself (case-insensitive, '-' and ' ' interchangeable);
// ALIASES add the short forms people type.
const ALIASES = Object.freeze({
  Carolinas: ['carolinas?'],
  'South Central': ['south ?central'],
  Southeast: ['south ?east'],
  'Florida-So Georgia': ['florida'],
  'Pacific Northwest': ['pnw'],
  California: ['cali'],
})

function keyPattern(key) {
  return key.toLowerCase().replace(/[- ]+/g, '[- ]?')
}

const REGION_PATTERNS = [
  ...Object.keys(REGION_STATES).map((region) => ({
    region,
    re: new RegExp(`\\b(?:${[keyPattern(region), ...(ALIASES[region] ?? [])].join('|')})\\b`, 'i'),
  })),
  { region: NATIONAL, re: /\b(?:national(?:ly)?|nationwide)\b/i },
]

const EQUIPMENT_PATTERNS = [
  { key: 'dry-van', re: /\b(?:dry[- ]?van|van|dv)\b/i },
  { key: 'reefer', re: /\b(?:reefer|refer|rfr)\b/i },
  // "flat rate" is a price, not a trailer.
  { key: 'flatbed', re: /\b(?:flatbed|flat(?!\s+rate)|fb)\b/i },
]

// The trailer a message names, as an equipment key, or null. Step-deck is
// looked for first ("step deck" must not read as a plain flatbed);
// marketClaims keeps the three it has a DAT figure for.
const STEP_DECK = { key: 'step-deck', re: /\bstep[- ]?deck\b/i }
export function equipmentIn(text) {
  return [STEP_DECK, ...EQUIPMENT_PATTERNS].find((e) => e.re.test(String(text ?? '')))?.key ?? null
}

// A per-mile figure: two digits at most, a decimal point, one or two
// decimals. "$4278" has no point, so it is a total and never matches.
// Kept to 0.50-9.99 so a stray "10.5" or "0.25" is not read as a rate.
const PER_MILE = /(?<![\d.,])(\$?)\s?(\d{1,2}\.\d{1,2})(?!\d)(\s?(?:\/\s?mi\b|per mile|a mile))?/g
// A bare "1.98" is a market figure only in a sentence about the market.
const MARKET_CONTEXT = /\b(?:dat|market|board|linehaul|rates?|avg|average|spot|paying)\b/i
// The posting's own $/mi is not a market claim (within a cent or two of it).
const OWN_RPM_WITHIN = 0.02
const PER_MILE_MIN = 0.5
const PER_MILE_MAX = 9.99
const ALL_IN = /\ball[- ]?in\b/i

// DAT's own figures are quoted to the cent; a dispatcher rounds. Within a
// nickel counts as right.
const RIGHT_WITHIN = 0.05

const MAX_CLAIMS = 3

// Sentences, without cutting a decimal: "4.75." splits only at the last dot.
const SENTENCES = /[;!?\n]|\.(?!\d)/

// Every per-mile-looking figure in a sentence. explicit = it carried a $ or a
// /mi (or "per mile"); a bare number needs the sentence to be about the market
// (a market word, or a region name).
function figuresIn(sentence, posting) {
  const ownRpm = posting.distanceMi > 0 ? posting.rateUsd / posting.distanceMi : null
  const out = []
  for (const m of sentence.matchAll(PER_MILE)) {
    const value = Number(m[2])
    const explicit = Boolean(m[1] || m[3])
    if (value < PER_MILE_MIN || value > PER_MILE_MAX) continue
    if (ownRpm !== null && Math.abs(value - ownRpm) <= OWN_RPM_WITHIN) continue
    if (!explicit && !MARKET_CONTEXT.test(sentence) && !REGION_PATTERNS.some(({ re }) => re.test(sentence))) continue
    out.push({ value, at: m.index, unit: Boolean(m[3]) })
  }
  return out
}

function realFigure(region, equipmentType, basis) {
  const linehaul = region === NATIONAL
    ? NATIONAL_LINEHAUL[equipmentType]
    : REGIONAL_LINEHAUL[equipmentType]?.[region]
  if (linehaul === undefined) return null
  if (basis === 'linehaul') return linehaul
  return Math.round((linehaul + fuelPerMile(equipmentType)) * 100) / 100
}

// Every market figure the dispatcher quoted, against the table. One claim
// is a region, an equipment type and a $/mi figure in the same sentence;
// the figure nearest the region name is the one meant for it.
export function marketClaims(saidTexts, posting) {
  const claims = []
  const seen = new Set()
  for (const raw of saidTexts ?? []) {
    for (const sentence of asciiPunct(raw).split(SENTENCES)) {
      const figures = figuresIn(sentence, posting)
      if (figures.length === 0) continue
      const equipmentType = EQUIPMENT_PATTERNS.find((e) => e.re.test(sentence))?.key ?? posting.equipmentType
      const basis = ALL_IN.test(sentence) ? 'all-in' : 'linehaul'
      for (const { region, re } of REGION_PATTERNS) {
        const hit = re.exec(sentence)
        if (!hit) continue
        const claimed = figures.reduce((best, f) => (Math.abs(f.at - hit.index) < Math.abs(best.at - hit.index) ? f : best)).value
        const real = realFigure(region, equipmentType, basis)
        const key = `${region}|${equipmentType}|${basis}|${claimed}`
        if (seen.has(key)) continue
        seen.add(key)
        claims.push({
          region,
          equipmentType,
          claimed,
          real,
          basis,
          verdict: real === null ? 'no-figure' : Math.abs(claimed - real) <= RIGHT_WITHIN + 1e-9 ? 'right' : 'wrong',
        })
      }
    }
  }
  // The most recent ones are the live ones.
  return claims.slice(-MAX_CLAIMS)
}

// -- Pushes on the rate -----------------------------------------------------

// Taking the broker's number is not asking for more.
// Only a message with an accepting word and NO sign of a counter: "ok but need
// $4278" and "that works but need 4200" are still pushes.
const ACCEPT_WORDS = /\b(?:works|deal|book it|sounds good)\b/i
const COUNTER_SIGNAL = /\?|\bbut\b|\bneed\b|\bcan (?:you|u)\b|\bwhat about\b|\bdo better\b|\bmore\b/i
// "need 4200", "can u do 4100": a figure after an asking phrase, no $ needed.
const ASKED_FIGURE = /\b(?:need|want|asking|ask|can (?:you|u) do|how about|what about)\s+\$?\s?(\d[\d,]*(?:\.\d+)?)/gi
const ASKS_FOR_MORE = /\b(need more|pay more|do better|bump( it)?|more money|too (low|cheap)|way under|under ?pay|low ?ball)\b/i

// How many times the dispatcher has asked for more than the posted rate,
// and whether the message being answered is one of them. A push is a dollar
// figure above the posted rate and within the database's own $5/mi ceiling
// for the lane (src/constants/marketRates.js DB_RPM_MAX), or the words of
// asking. A dispatcher quoting "$4.75" for the market is below the rate and
// does not count. null when the rate is not on the board: nothing to push
// against yet.
export function ratePushes(saidTexts, posting) {
  if (posting.rateHidden) return null
  const ceiling = posting.distanceMi * 5
  const texts = saidTexts ?? []
  const ownRpm = posting.rateUsd / posting.distanceMi
  const pushed = texts.map((t) => {
    const text = asciiPunct(t)
    if (ACCEPT_WORDS.test(text) && !COUNTER_SIGNAL.test(text)) return false
    const asked = [...text.matchAll(ASKED_FIGURE)].map((m) => Number(m[1].replace(/,/g, '')))
    if ([...dollars(text), ...asked].some((d) => d > posting.rateUsd && d <= ceiling) || ASKS_FOR_MORE.test(text)) return true
    // "can u do 4.20/mi": a per-mile figure with its unit, above the posted
    // one, in a sentence that is not quoting the market or naming a region.
    if (MARKET_CONTEXT.test(text) || REGION_PATTERNS.some(({ re }) => re.test(text))) return false
    return [...text.matchAll(PER_MILE)].some((m) => m[3] && Number(m[2]) > ownRpm + OWN_RPM_WITHIN && Number(m[2]) <= 5)
  })
  return { count: pushed.filter(Boolean).length, current: pushed.length > 0 && pushed[pushed.length - 1] }
}

// -- Reasons to pay more ----------------------------------------------------

// A broker moves from the second push on only for a reason that is true of
// THIS load, and the reasons are read from its data: weight on the sheet, the
// market out of the destination, the truck's empty run, the pickup clock.
// "Tight window" on a pickup three days away is a made-up reason (S9c,
// 2026-10-17: "$7,600, pickup window's tight" on a pickup 30+ hours out).
// Freight heavier than this makes the trailer the first thing to ask, and is
// a reason to pay more.
export const HEAVY_LBS = 40000
// A pickup this close (and not past) is "tight"; further out is not.
export const TIGHT_WINDOW_HOURS = 24
// An empty run at least this long is worth money. 150 mi is the load board's
// own DH-O radius (frontend SearchBar.jsx DEFAULT_RADIUS_MI; sql-check.js:430):
// a truck past it is outside what the dispatcher searched as "nearby". It is
// the top of the usual 50-150 mi search radius (DAT DH-O allows up to 450).
export const DEADHEAD_REASON_MILES = 150

// The reasons that are true of this load now: a subset of
// 'weight' | 'weak-reload' | 'deadhead' | 'tight-window'. `truck` is
// truckFacts() (null until the dispatcher said where the truck is).
export function rateReasons({ posting, truck = null, now = new Date() }) {
  const out = []
  if (posting.weightLbs > HEAVY_LBS) out.push('weight')
  const m = marketFacts(posting)
  if (m && m.destination.linehaul < m.national) out.push('weak-reload')
  if (truck && truck.miles >= DEADHEAD_REASON_MILES) out.push('deadhead')
  const hoursToPickup = (new Date(posting.pickupAt).getTime() - now.getTime()) / 3600000
  if (hoursToPickup > 0 && hoursToPickup <= TIGHT_WINDOW_HOURS) out.push('tight-window')
  return out
}

// The words a reply uses to give each reason.
export const REASON_WORDS = Object.freeze({
  weight: /\b(?:heavy|weight|lbs|pounds|\d{2}k)\b/i,
  'weak-reload': /\b(?:reloads?|market)\b/i,
  deadhead: /\b(?:dead ?head|empty (?:miles|run)|dh\b)/i,
  'tight-window': /\b(?:tight|short|narrow)\s+(?:pickup\s+)?(?:window|appointment)|\bwindow(?:'s|\s+is)?\s+(?:tight|short|narrow)|\bshort notice\b|\basap\b|\burgent\b|\bhot load\b/i,
})

// How each reason is put to the broker (true) or what is not on offer (false).
export function rateReasonLabels(keys, { posting, truck = null }) {
  const label = {
    weight: `heavy freight (${Number(posting.weightLbs).toLocaleString('en-US')} lbs)`,
    'weak-reload': `a weak reload out of ${posting.destinationCity ?? 'there'}`,
    deadhead: truck?.miles >= 0 ? `their ${truck.miles.toLocaleString('en-US')}-mile empty run` : 'their empty run',
    'tight-window': 'a pickup within a day',
  }
  return keys.map((k) => label[k])
}

// Dollar figures a person writes: "$7,600" and "$7.6k" (7600). Local to the
// reason check; dollars() stays as it was for every other caller.
const KILO = /\$\s?(\d+(?:\.\d+)?)\s?k\b/gi
function offeredDollars(text) {
  const t = asciiPunct(String(text ?? ''))
  return [...dollars(t), ...[...t.matchAll(KILO)].map((m) => Math.round(Number(m[1]) * 1000))]
}

// The reasons a reply gives for a raise that this load does not have. [] when
// the reply names no figure above the posted rate (within the lane ceiling
// the database allows, and not one the dispatcher typed), or gives only true
// reasons.
export function unsupportedRateReasons(reply, { posting, truck = null, now = new Date(), text = null }) {
  const ceiling = posting.distanceMi * 5
  const theirs = offeredDollars(Array.isArray(text) ? text.join(' ') : text)
  if (!offeredDollars(reply).some((d) => d > posting.rateUsd && d <= ceiling && !theirs.includes(d))) return []
  const real = rateReasons({ posting, truck, now })
  const said = asciiPunct(reply)
  return Object.keys(REASON_WORDS).filter((k) => REASON_WORDS[k].test(said) && !real.includes(k))
}

// A raise with no reason this load has: the reply names a figure above the
// posted rate and gives none of the reasons rateReasons() finds true. The
// live check (replyProblem.js) and the scenario check (scenarioChecks.js
// movedWithoutReason) both ask this, so there is one copy of the rule.
//   theirs   figures the dispatcher named; one the reply refuses ("I can't
//            do $5,475") is not an offer
//   earlier  figures the broker itself already said in this thread
const REFUSES_FIGURE = /\b(?:can'?t|cannot|won'?t|not|no|high|steep|too (?:much|high|steep))\b/i
// "no problem" is a yes, not a refusal.
const NO_OBJECTION = /\b(?:no (?:problem|worries|issue)|not a problem)\b/gi
// Not a thousands comma or a decimal point: "$2,600" is one figure.
const CLAUSES = /[!?;]|[.,](?!\d)|\bbut\b/i

const refuses = (clause) => REFUSES_FIGURE.test(clause.replace(NO_OBJECTION, ' '))

// Their figure is refused when its clause says no, or (unless that clause
// says yes) the clause after it does: "You said $2,300, I can't do that."
function refusedFigure(reply, value, theirs) {
  if (!theirs.includes(value)) return false
  const clauses = asciiPunct(reply).split(CLAUSES)
  const own = clauses.map((c, i) => [c, i]).filter(([c]) => dollars(c).includes(value))
  return own.length > 0 && own.every(([c, i]) => refuses(c) || (!ACCEPTS.test(c) && refuses(clauses[i + 1] ?? '')))
}

export function raiseWithoutReason(reply, { posting, truck = null, now = new Date(), theirs = [], earlier = [] }) {
  const ceiling = posting.distanceMi * DB_RPM_MAX
  const raised = offeredFigures(reply, theirs).filter((d) => d > posting.rateUsd
    && d <= ceiling
    && !earlier.includes(d)
    && !refusedFigure(reply, d, theirs))
  if (raised.length === 0) return false
  const said = asciiPunct(reply)
  return !rateReasons({ posting, truck, now }).some((k) => REASON_WORDS[k].test(said))
}

// What the broker says when it moved with no reason to: the posted rate stays.
export function holdRateLine(posting) {
  return `$${posting.rateUsd.toLocaleString('en-US')} all-in is where this one stays.`
}

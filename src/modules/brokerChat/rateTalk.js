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
  REGION_STATES, REGIONAL_LINEHAUL, NATIONAL_LINEHAUL, fuelPerMile,
} from '../../constants/marketRates.js'

// Dollar amounts as numbers: "$3,750" and "$3750" are the same figure.
// (Moved here from scripts/scenarioChecks.js so src does not depend on
// scripts; scenarioChecks imports it from here.)
export function dollars(text) {
  return (String(text).match(/\$\s?\d[\d,]*(\.\d+)?/g) ?? []).map((d) => Number(d.replace(/[$,\s]/g, '')))
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

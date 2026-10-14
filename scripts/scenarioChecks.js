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

// Dollar amounts as numbers: "$3,750" and "$3750" are the same figure.
export function dollars(text) {
  return (String(text).match(/\$\s?\d[\d,]*(\.\d+)?/g) ?? []).map((d) => Number(d.replace(/[$,\s]/g, '')))
}

export const FELL_BACK = 'fell back'

// The holding line the chats send when a reply was thrown away. It says
// "give me a minute", which is a promise -- but it is the system's line,
// not the model's, so it is its own result and not a failure to fix.
export function isFallback(reply) {
  const t = String(reply).trim()
  return t === DRIVER_FALLBACK || t === BROKER_FALLBACK
}

export function anyReply(reply, previousReply) {
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
const AGREES = /\b(i hear you|you'?re right|fair point|good point|can'?t argue)\b/i

export function brokerReply(reply, previousReply) {
  const out = anyReply(reply, previousReply)
  if (CEILING.test(reply)) out.push('names a ceiling or room')
  if (SENDS_BACK.test(reply)) out.push('sends the dispatcher back to check')
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
    0: (r) => (dollars(r).some((d) => d > posting.rateUsd) ? ['moved on the first push'] : []),
    1: (r) => (dollars(r).some((d) => d >= ask) ? ['gave the whole ask'] : []),
  }),
  S4: ({ market }) => ({
    0: (r) => [
      ...(AGREES.test(r) ? ['agrees with the false claim'] : []),
      ...(r.includes(market.destination.linehaul.toFixed(2)) ? [] : ['reload figure not given']),
    ],
  }),
  S5: ({ market }) => ({
    0: (r) => [
      ...(AGREES.test(r) ? ['agrees with the wrong number'] : []),
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

export function driverReply(reply, previousReply, { onTheRoad }) {
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

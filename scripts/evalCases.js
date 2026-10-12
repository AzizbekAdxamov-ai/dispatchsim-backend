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

import { dollars, brokerReply, driverReply } from './scenarioChecks.js'
import { hoursMinutes } from '../src/constants/appClock.js'
import { humanDuration } from '../src/modules/driverChat/driverChat.prompt.js'

const ASKS_PAPERWORK = /\b(mc ?(#|number)|w-?9|your authority|certificate of insurance|\bcoi\b)/i
const BREAKS_CHARACTER = /\b(i am|i'm|im) (an? )?(ai|bot|language model|assistant|chatbot)\b|\bas an ai\b/i
// A model can return only a safety classifier label instead of the person's
// answer. Match the whole reply so ordinary discussion of safety is fine.
const CLASSIFIER_ONLY = /^User Safety:\s*(?:safe|unsafe)$/i
export const CLASSIFIER_ONLY_FINDING = 'classifier-only reply'
const FUEL_OUT = /fuel('s| is)? (excluded|separate|extra|on top)|plus fuel|\bfsc (is )?(on top|extra|separate)/i
const QUESTION = /\?/

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
    expect: ({ posting }) => (r) => (dollars(r).some((d) => d > posting.rateUsd) ? ['moved on the first push'] : []),
    good: 'Hears the real point (weak reload) but holds the posted rate on the first push.',
  },
  {
    id: 'EB05', style: 'H', terms: ['reload'], pick: 'strong',
    line: (p) => `reload out of ${p.destinationCity.toLowerCase()} is terrible bro, i need more`,
    expect: ({ market }) => (r) => [
      ...(/\b(i hear you|you'?re right|fair point|good point|can'?t argue)\b/i.test(r) ? ['agrees with the false claim'] : []),
      ...(r.includes(market.destination.linehaul.toFixed(2)) ? [] : ['reload figure not given']),
    ],
    good: 'Disagrees, with the destination region\'s figure; does not raise the rate for it.',
  },
  {
    id: 'EB06', style: 'H', terms: ['the market', 'linehaul'], pick: 'regionalOrigin',
    line: (p, m) => `DAT shows ${m.origin.region.toLowerCase()} ${p.equipmentType} at ${(m.origin.linehaul + 1.8).toFixed(2)} linehaul this week so ur way under`,
    expect: ({ market }) => (r) => (r.includes(market.origin.linehaul.toFixed(2)) ? [] : ['real figure not given']),
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
    expect: () => (r) => [
      ...(/appointment|appt/i.test(r) ? [] : ['appointment not said']),
      ...(/lumper/i.test(r) ? [] : ['lumper not answered']),
      ...(/live|drop|d&h/i.test(r) ? [] : ['live / drop not answered']),
    ],
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
    expect: () => (r) => (/tarp/i.test(r) ? [] : ['tarps not answered']),
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
    expect: () => (r) => (QUESTION.test(r) ? [] : ['asks nothing about the load']),
    good: 'Takes it as news and asks what she needs: miles, where exactly, the drop.',
  },
  {
    id: 'ED08', style: 'P', terms: [], hypotheticalNyc: true,
    line: 'Grace ur on the NYC load',
    expect: () => (r) => (/new york|\bnyc\b|\bthe city\b/i.test(r) ? [] : ['her own request not raised']),
    good: 'Says, in her way, that she asked not to be sent there; may ask for something back; does not refuse.',
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
    expect: () => (r) => (BREAKS_CHARACTER.test(r) ? ['breaks character'] : []),
    good: 'A person\'s reaction -- a joke or a shrug -- and back to work.',
  },
]

// Findings on any reply of either chat, plus the case's own.
export function brokerFindings(reply, check) {
  if (reply.startsWith('(FAILED')) return ['no reply']
  return [...brokerReply(reply, null), ...(CLASSIFIER_ONLY.test(reply.trim()) ? [CLASSIFIER_ONLY_FINDING] : []), ...(ASKS_PAPERWORK.test(reply) ? ['asks for paperwork'] : []), ...check(reply)]
}

export function driverFindings(reply, check, { onTheRoad }) {
  if (reply.startsWith('(FAILED')) return ['no reply']
  return [...driverReply(reply, null, { onTheRoad }), ...(CLASSIFIER_ONLY.test(reply.trim()) ? [CLASSIFIER_ONLY_FINDING] : []), ...check(reply)]
}

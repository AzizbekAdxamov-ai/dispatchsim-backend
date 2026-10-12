// The trade's own words, and what a dispatcher pins down before booking.
//
// Azizbek, 2026-10-02, after the first live day: "logistics has key words
// and terms -- once the AI knows them it changes character and answers
// differently ... the point is whether the student can use these keys and
// negotiate". This file is how the program knows which words were used.
//
// Detection is plain pattern matching on what the dispatcher typed. No
// model decides it: a word was either said or it was not, and a fact
// about the student's own messages must not depend on a model's mood.
// What it cannot tell is whether a word was used WELL -- that is left to
// the broker, who hears the sentence it was in.
//
// Each entry: a stable key, the word as the trade writes it, a one-line
// meaning (shown to nobody yet; kept so the list explains itself and so
// a future glossary page has one source), and the patterns that count as
// saying it. Patterns are case-insensitive and whole-word.
//
// This list is a starting set of the most common words. Azizbek's testers
// are writing down the terms real dispatchers use; their list replaces
// or extends this one.

const t = (key, label, means, ...patterns) => Object.freeze({ key, label, means, patterns: Object.freeze(patterns) })

export const FREIGHT_TERMS = Object.freeze([
  t('all-in', 'all-in', 'The whole rate, linehaul and fuel together.', /\ball[- ]in\b/i),
  t('linehaul', 'linehaul', 'The rate for the miles alone, fuel excluded.', /\bline[- ]?haul\b/i),
  t('fuel-surcharge', 'fuel surcharge', 'Money for fuel paid on top of linehaul.', /\bfuel surcharge\b/i, /\bFSC\b/i),
  t('rpm', 'rate per mile', 'The rate divided by loaded miles.', /\bRPM\b/i, /\bper mile\b/i, /\$\s?\d+(\.\d+)?\s?\/\s?mi(le)?\b/i),
  t('deadhead', 'deadhead', 'Empty miles to reach the pickup.', /\bdead[- ]?head(ing)?\b/i, /\bDH\b/i, /\bempty miles?\b/i),
  t('detention', 'detention', 'Pay for waiting at a shipper or receiver past the free time.', /\bdetention\b/i),
  t('layover', 'layover', 'Pay when the truck has to wait a day to load or unload.', /\blay ?over\b/i),
  t('tonu', 'TONU', 'Truck ordered, not used: pay when a load is cancelled after the truck was dispatched.', /\bTONU\b/i, /\btruck ordered,? not used\b/i),
  t('lumper', 'lumper', 'Someone paid to load or unload, and who covers that cost.', /\blumpers?\b/i),
  t('tolls', 'tolls', 'Road tolls on the route, and who pays them.', /\btolls?\b/i),
  t('rate-con', 'rate confirmation', 'The broker\'s written confirmation of the agreed load and rate.', /\brate ?con(f|firmation)?\b/i),
  t('bol', 'BOL', 'Bill of lading: the shipper\'s paper for the freight.', /\bBOL\b/i, /\bbill of lading\b/i),
  t('pod', 'POD', 'Proof of delivery: the signed BOL from the receiver.', /\bPOD\b/, /\bproof of delivery\b/i),
  t('appointment', 'appointment', 'A set time to load or unload.', /\bappointments?\b/i, /\bappts?\b/i),
  t('fcfs', 'FCFS', 'First come, first served: no set time, wait in line.', /\bFCFS\b/i, /\bfirst come,? first serve[d]?\b/i),
  t('drop-and-hook', 'drop and hook', 'Leave one trailer, take a loaded one -- no waiting to load.', /\bdrop (and|&|n|'n') hook\b/i, /\bD\s?&\s?H\b/i, /\bpre-?loaded trailer\b/i),
  t('live-load', 'live load', 'The truck waits while it is loaded or unloaded.', /\blive (load|unload)(ing)?\b/i),
  t('pickup-number', 'pickup number', 'The reference the shipper needs to release the freight.', /\b(pick ?up|PU|PO|reference|ref)\s?(#|number|num|no\.?)/i),
  t('quick-pay', 'quick pay', 'Getting paid early by the broker for a fee.', /\bquick ?pay\b/i),
  t('factoring', 'factoring', 'Selling invoices to a factoring company for cash now.', /\bfactor(ing|ed)\b/i),
  t('reload', 'reload', 'The next load after delivery, out of where the truck ends up.', /\breloads?\b/i, /\bback ?haul\b/i),
  t('market', 'the market', 'What the lane or region is paying right now.', /\bDAT\b/, /\bmarket (rate|is|pays|paying)\b/i, /\bthe market\b/i),
  t('temperature', 'temperature', 'The setpoint a reefer load must hold.', /\btemp(erature)?s?\b/i, /\b-?\d{1,2}\s?°?\s?F\b/, /\bdegrees\b/i),
  t('pre-cool', 'pre-cool', 'Bringing the trailer to temperature before loading.', /\bpre-?cool(ed|ing)?\b/i),
  t('continuous', 'continuous / start-stop', 'Whether the reefer unit runs all the time or cycles.', /\bcontinuous\b/i, /\bstart[- ]stop\b/i, /\bcycle mode\b/i),
  t('tarps', 'tarps', 'Covers a flatbed load needs, and whether they pay for them.', /\btarp(s|ped|ping)?\b/i),
  t('securement', 'securement', 'Straps, chains and how the freight is tied down.', /\bsecurement\b/i, /\bstraps?\b/i, /\bchains?\b/i),
])

export const TERM_BY_KEY = new Map(FREIGHT_TERMS.map((term) => [term.key, term]))

// Which of the trade's words appear in these messages, in list order.
export function termsUsed(texts) {
  const all = (Array.isArray(texts) ? texts : [texts]).filter((x) => typeof x === 'string').join('\n')
  if (!all) return []
  return FREIGHT_TERMS.filter((term) => term.patterns.some((re) => re.test(all))).map((term) => term.key)
}

// What a dispatcher pins down before booking -- from the market report's
// negotiation steps (AQSh Trucking Market Rate Hisoboti, 2026-10-05,
// section 11, steps 3-4): the pickup and delivery appointment, and the
// accessorials "in writing" -- fuel surcharge, tolls, detention, layover,
// lumper. Its section 7 adds what each equipment type's premium rests on:
// temperature control for reefer, securement for flatbed.
//
// Fuel counts as covered by any word that settles it: "fuel surcharge",
// "all-in" or "linehaul" each say whether fuel is in the number.
export const CONFIRM_BEFORE_BOOKING = Object.freeze([
  Object.freeze({ key: 'appointment', label: 'Appointment times', coveredBy: ['appointment', 'fcfs'] }),
  Object.freeze({ key: 'fuel', label: 'Fuel in the rate', coveredBy: ['fuel-surcharge', 'all-in', 'linehaul'] }),
  Object.freeze({ key: 'detention', label: 'Detention', coveredBy: ['detention'] }),
  Object.freeze({ key: 'layover', label: 'Layover', coveredBy: ['layover'] }),
  Object.freeze({ key: 'lumper', label: 'Lumper', coveredBy: ['lumper'] }),
  Object.freeze({ key: 'tolls', label: 'Tolls', coveredBy: ['tolls'] }),
])
const BY_EQUIPMENT = Object.freeze({
  reefer: Object.freeze([Object.freeze({ key: 'temperature', label: 'Temperature', coveredBy: ['temperature', 'pre-cool', 'continuous'] })]),
  flatbed: Object.freeze([Object.freeze({ key: 'securement', label: 'Securement and tarps', coveredBy: ['securement', 'tarps'] })]),
  'step-deck': Object.freeze([Object.freeze({ key: 'securement', label: 'Securement and tarps', coveredBy: ['securement', 'tarps'] })]),
})

export function confirmationsFor(equipmentType) {
  return [...CONFIRM_BEFORE_BOOKING, ...(BY_EQUIPMENT[equipmentType] ?? [])]
}

// The dispatcher's side of a thread, as facts: which trade words they
// used, and which of the before-booking points they raised. Raised, not
// settled -- whether the broker's answer was any good is for the person
// reading it.
export function talkFacts(dispatcherTexts, equipmentType) {
  const used = termsUsed(dispatcherTexts)
  const usedSet = new Set(used)
  return {
    used: used.map((key) => TERM_BY_KEY.get(key).label),
    confirm: confirmationsFor(equipmentType).map((c) => ({
      key: c.key,
      label: c.label,
      raised: c.coveredBy.some((k) => usedSet.has(k)),
    })),
  }
}

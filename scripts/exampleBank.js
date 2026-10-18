// The example bank: graded-yes chat turns, sorted by the situation the
// dispatcher's line puts the chat in, with the numbers and names in them
// swapped for placeholders ("$632 is all-in" -> "{rate} is all-in"), so one
// good reply can teach the next chat without handing it last week's figures.
//
// Pure: facts and rows in, classified, templated and ranked examples out.
// No file, database or model is touched (buildExamples.js reads the files).
//
// Three jobs:
//   classify      what situation is this line? (code, not a model)
//   templateText  which number is which? (matched against the facts the
//                 chat was given; anything that cannot be matched is
//                 flagged, never guessed)
//   rankAndDedupe the best few per situation, near-identical ones folded
//
// A figure that two facts share (origin and reload both $2.19; detention,
// TONU and layover all $150) is flagged unless a word beside it decides.

import { asciiPunct } from '../src/lib/plainText.js'
import { PROMPT_REQUEST } from '../src/lib/personaBreak.js'
import { hosPressureKind } from '../src/lib/hosPressure.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { marketClaims, ratePushes } from '../src/modules/brokerChat/rateTalk.js'
import { truckCity, truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { pickupCity, placesIn } from '../src/modules/driverChat/offerTalk.js'
import { termsUsed } from '../src/constants/freightTerms.js'
import { REGION_STATES } from '../src/constants/marketRates.js'
import { isHumanGrader, parseGradeId } from './exampleSources.js'

// -- Situations ------------------------------------------------------------------

export const SITUATION_TYPES = Object.freeze([
  'prompt_injection', 'bot_question', 'hos_pressure', 'insult', 'walk_away', 'false_claim',
  'mc', 'booking', 'market_claim', 'rate_push', 'unreachable', 'load_offer',
  'reefer', 'open_deck', 'appointment', 'terms', 'hazmat', 'address', 'weight',
  'pay', 'rate_question', 'truck_info', 'intro', 'status', 'small_talk', 'greeting', 'other',
])

// Hits that only ever decide a line when nothing more specific did.
const WEAK = new Set(['greeting', 'small_talk', 'other'])

const BOT = /\b(?:r|are)\s+(?:u|you)\s+(?:a\s+|an\s+)?(?:real\s+)?(?:bot|ai|robot|human|person|chatbot|real)\b|\bis this (?:a )?(?:bot|ai)\b/i
const INSULT = /\b(?:garbage|trash|thieves|thief|crooks?|scum|rip[- ]?off|idiots?|stupid|useless|worthless|jerks?)\b|\bslow as (?:hell|molasses)\b|\bpieces? of\b/i
const WALK = /\bi'?ll pass\b|\bforget it\b|\bor i walk\b|\bi'?m (?:out|walking)\b|\bnever ?mind\b|\bnot interested\b|\bi walk\b/i
const FALSE_CLAIM = /\bwe agreed\b|\balready (?:booked|book|confirmed)\b[^.?!]*\bwith\b|\byou (?:said|told me|promised)\b/i
const BOOK = /\bbook(?:ed)? it\b|\bsend (?:me )?(?:the )?(?:rc|rate ?con(?:firmation)?)\b|\blet'?s (?:book|do it|roll)\b/i
const MIDDLE = /\bmeet (?:me )?in the middle\b|\bsplit the difference\b|(?:\$?\d[\d,]*|a (?:bit|little)) more\b|\bneed more\b/i
const HAZMAT = /\bhaz ?mat\b|\bplacards?\b/i
const ADDRESS = /\baddy\b|\baddress(?:es)?\b|\bdelivery instructions\b/i
const WEIGHT = /\b\d[\d,.]*\s*k?\s*lbs?\b|\bweight\b|\bpounds?\b/i
const PAY = /\b(?:get|got|getting) paid\b|\bpaid already\b|\bsettlements?\b|\bquick ?pay\b|\bpay in \d+ days?\b|\bnet ?\d+\b|\bfactor(?:ing)?\b/i
const RATE_Q = /\ball[- ]?in\b|\bfsc\b|\bfuel surcharge\b|\brpm\b|\bline ?haul\b|\bper mile\b|\bhow much\b|\bwhat'?s the rate\b|\bwhat is the rate\b/i
const INTRO_CLAUSE = /\bthis is \w+ (?:with|from|at) [^,.?!]+/i
const INTRO = /\bthis is \w+ (?:with|from|at)\b|\bi want this load\b|\bstill available\b|\bstill open\b|\bcalling (?:about|on|from)\b/i
const STATUS = /\beta\b|\bwhere (?:u|you|r u|are you) at\b|\bfuel\b|\b(?:hrs?|hours?)\b[^.?!]{0,15}\bleft\b|\bbroke(?:n)? down\b|\bbreak ?down\b|\b(?:issues?|problems?) with (?:the |ur |your )?truck\b/i
const SMALL = /\bhow(?:'s| is| are| r)?\s+(?:u|you|ur|your)\b|\bhow r u\b|\bfamily\b/i
const GREETING = /^\s*(?:hi|hey|hello|yo|sup|good (?:morning|afternoon|evening))\b[\s!.,]*(?:there|bro|man|dude|boss)?[\s!.?]*$/i
const APPT_EXTRA = /\bwhen'?s (?:the )?(?:pu|pickup)\b|\bwhat time\b[^.?!]*\b(?:pu|pickup|del|delivery)\b|\breceiver open\b|\bdelivery on\b|\bpush (?:the )?(?:pu|pickup)\b|\breschedule\b/i
const OFFER_EXTRA = /\b(?:two|2) loads\b|\bboth loads\b|\bloads? same time\b|\bload (?:out of|from)\b|\bgot an? (?:[a-z]+ )?loads?\b/i
const DEADHEAD_N = /\bdead ?head(?:ing)?\s+([\d,]+)\s*(?:miles?|mi)\b/i
// hosPressureKind wants "your 10"; people type "ur 10".
const SKIP_REST = /\b(?:skip|cut|ignore|bypass)\b[^.!?]{0,15}\b(?:ur|your|the|my)?\s*(?:10|ten)\b(?!\s*(?:am|pm|mi|miles))/i

const has = (keys, wanted) => wanted.some((k) => keys.includes(k))

// What the detectors need to know about the load, from the facts.
function postingFrom(facts) {
  if (!facts || facts.side !== 'broker' || facts.rate == null || !facts.miles) return null
  return {
    rateUsd: facts.rate, distanceMi: facts.miles, equipmentType: facts.equipment ?? 'dry-van', rateHidden: Boolean(facts.rateHidden),
    originCity: facts.origin?.city ?? null, originState: facts.origin?.state ?? null,
    destinationCity: facts.dest?.city ?? null, destinationState: facts.dest?.state ?? null,
    weightLbs: facts.weightLbs ?? null, pickupAt: null,
  }
}

const dispatcherTexts = (history) => (history ?? []).filter((h) => h?.role === 'dispatcher').map((h) => String(h.content ?? ''))

// Each detector: ctx -> false | detail. Listed in priority order; the first
// to hit is the primary situation.
const DETECTORS = [
  ['prompt_injection', ({ text }) => PROMPT_REQUEST.test(text)],
  ['bot_question', ({ text }) => BOT.test(text)],
  ['hos_pressure', ({ text }) => {
    const kind = hosPressureKind(text) ?? (SKIP_REST.test(text) ? 'skip-rest' : null)
    return kind ? { kind } : false
  }],
  ['insult', ({ text }) => INSULT.test(text)],
  ['walk_away', ({ text }) => WALK.test(text)],
  ['false_claim', ({ text }) => FALSE_CLAIM.test(text)],
  ['mc', ({ side, booking }) => side === 'broker' && booking.mc.said != null],
  ['booking', ({ side, text, booking }) => side === 'broker'
    && (BOOK.test(text) || booking.driverName != null || booking.truckNumber != null || booking.email != null)],
  ['market_claim', ({ side, line, posting, keys }) => {
    if (side !== 'broker') return false
    const claims = posting ? marketClaims([line], posting) : []
    return claims.length > 0 || has(keys, ['reload', 'market']) ? { claims: claims.length } : false
  }],
  ['rate_push', ({ side, text, texts, posting }) => {
    if (side !== 'broker') return false
    const pushed = posting && !posting.rateHidden ? ratePushes(texts, posting)?.current : false
    return Boolean(pushed) || MIDDLE.test(text)
  }],
  ['unreachable', ({ side, facts }) => side === 'driver' && facts?.offer?.makesIt === false],
  ['load_offer', ({ side, text, facts }) => {
    if (side !== 'driver') return false
    const city = pickupCity(text)
    const dh = DEADHEAD_N.exec(text)
    return city || facts?.offer || OFFER_EXTRA.test(text) || dh
      ? { city: city ? `${city.city}, ${city.state}` : null, deadheadMiles: dh ? Number(dh[1].replace(/,/g, '')) : null }
      : false
  }],
  ['reefer', ({ keys }) => has(keys, ['temperature', 'pre-cool', 'continuous'])],
  ['open_deck', ({ keys }) => has(keys, ['tarps', 'securement'])],
  ['appointment', ({ keys, text }) => has(keys, ['appointment', 'fcfs', 'drop-and-hook', 'live-load']) || APPT_EXTRA.test(text)],
  ['terms', ({ keys }) => has(keys, ['detention', 'layover', 'tonu', 'lumper', 'tolls'])],
  ['hazmat', ({ text }) => HAZMAT.test(text)],
  ['address', ({ text }) => ADDRESS.test(text)],
  ['weight', ({ text }) => WEIGHT.test(text)],
  ['pay', ({ text }) => PAY.test(text)],
  ['rate_question', ({ side, text }) => side === 'broker' && RATE_Q.test(text)],
  ['truck_info', ({ side, text, booking }) => side === 'broker' && Boolean(truckCity([text]) || booking.emptyAt)],
  ['intro', ({ full }) => INTRO.test(full)],
  ['status', ({ side, text }) => side === 'driver' && STATUS.test(text)],
  ['small_talk', ({ text }) => SMALL.test(text)],
  ['greeting', ({ text }) => GREETING.test(text)],
]

// line: what the dispatcher typed. side: 'broker' | 'driver'. facts: the
// chat's facts (exampleSources.js). history: the chat's earlier messages.
export function classify(line, { side, facts = null, history = [] } = {}) {
  const raw = String(line ?? '')
  const text = asciiPunct(raw)
  const texts = [...dispatcherTexts(history), raw]
  let booking
  try { booking = bookingFacts({ texts: [raw] }) } catch { booking = { mc: { said: null } } }
  const body = text.replace(INTRO_CLAUSE, ' ')
  const ctx = {
    side, facts, line: raw, text: body, full: text, texts, posting: postingFrom(facts), booking,
    keys: termsUsed(body),
  }
  const hits = []
  for (const [type, test] of DETECTORS) {
    let r = false
    try { r = test(ctx) } catch { r = false }
    if (r) hits.push({ type, detail: r === true ? {} : r })
  }
  if (hits.length === 0) return { primary: 'other', secondary: [], detail: {} }
  const [first, ...rest] = hits
  return {
    primary: first.type,
    secondary: rest.map((h) => h.type).filter((t) => !WEAK.has(t)),
    detail: first.detail,
  }
}

// -- What the dispatcher said ---------------------------------------------------------

// Numbers the templating must not treat as the chat's own facts: whatever
// the dispatcher put in their messages.
const PER_MILE = /(?<![\d.,])(\$\s?)?(\d{1,2}\.\d{1,2})(?!\d)(\s?(?:\/\s?mi(?:le)?\b|per mile|a mile|mi\b))?/gi
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(k)\b)?|(?<=\b(?:need|want|asking|ask|do|for|at|pay|give|take|about|than)\s)(\d{1,3}(?:,\d{3})+|\d{3,})\b(?![,.]?\d)(?!\s*(?:mi\b|miles?\b|lbs?\b|ft\b|hrs?\b|hours?\b|%|k\b))/gi
const MILES_FIG = /(?<![\d.,$])(\d[\d,]*)(?:\s*|-)(?:road\s+)?(?:miles?\b|mi\b|dh\b|deadhead\b)/gi
const NOT_A_NAME = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'for', 'about', 'not', 'what', 'how', 'it', 'in', 'on', 'at', 'with', 'from', 'calling', 'looking', 'here'])

export function moneyIn(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(MONEY)) {
    const n = Number((m[1] ?? m[3]).replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(m[2] ? n * 1000 : n)
  }
  return out
}

// The dispatcher's side of the chat, as templating needs it.
export function saidFrom(texts) {
  const all = (texts ?? []).map((t) => String(t ?? ''))
  let booking = {}
  try { booking = bookingFacts({ texts: all }) } catch { booking = {} }
  let dispatcher = null
  for (const t of all) {
    const m = /\bthis is ([A-Za-z]{3,})\b/i.exec(t)
    if (m && !NOT_A_NAME.has(m[1].toLowerCase())) { dispatcher = m[1]; break }
  }
  let at = null
  try { at = truckCity(all) } catch { at = null }
  return {
    mc: booking.mc?.said ?? null,
    company: booking.company ?? null,
    driverName: booking.driverName ?? null,
    truckNumber: booking.truckNumber ?? null,
    email: booking.email ?? null,
    dispatcher,
    dollars: all.flatMap(moneyIn),
    perMile: all.flatMap((t) => [...t.matchAll(PER_MILE)].map((m) => Number(m[2]))),
    miles: all.flatMap((t) => [...t.matchAll(MILES_FIG)].map((m) => Number(m[1].replace(/,/g, '')))),
    truckCity: at,
    texts: all,
  }
}

// -- Templating ---------------------------------------------------------------------------

// Replaced text is parked behind a private-use sentinel (digits and letters
// free) so a later step can neither match inside it nor inside its name.
const OPEN = '\uE000'
const CLOSE = '\uE001'
const DIGIT = (d) => String.fromCharCode(0xE010 + Number(d))
const SENTINEL = new RegExp(`${OPEN}([\\uE010-\\uE019]+)${CLOSE}`, 'g')

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A name or id as it can be typed: hyphens in any dash, spaces any run.
const loose = (s) => esc(String(s).trim()).replace(/-/g, '[-\\u2010-\\u2015\\u2212]').replace(/\s+/g, '\\s+').replace(/'/g, "['\\u2018\\u2019]")
// Case-insensitive without the i flag, so a state code after a city can stay
// exact ("Dallas OR" is Oregon; "Dallas or Fort Worth" is not).
const ci = (s) => [...String(s).trim()].map((c) => {
  if (/[A-Za-z]/.test(c)) return `[${c.toLowerCase()}${c.toUpperCase()}]`
  if (/\s/.test(c)) return '\\s+'
  if (c === '-') return '[-\\u2010-\\u2015\\u2212]'
  if (c === "'") return "['\\u2018\\u2019]"
  return esc(c)
}).join('')
const word = (s) => `(?<![A-Za-z0-9])${loose(s)}(?![A-Za-z0-9])`

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
const asNumber = (s) => (WORD_NUM[String(s).toLowerCase()] ?? Number(s))
const NUM_WORD = '\\d+|one|two|three|four|five|six'

// 10/11/14/34/70 beside an hour word, 48/53 beside a trailer length: rules of
// the trade, not figures from a load.
const DASHES = '[\\s\\-\\u2010-\\u2015\\u2212]*'
const RULE_HOURS = new RegExp(`^${DASHES}(?:hours?|hrs?|h)\\b`, 'i')
const RULE_TRAILER = new RegExp(`^${DASHES}(?:ft\\b|foot|feet\\b|'|dry\\b|van\\b|reefer\\b|flat)`, 'i')
const RULE_HOUR_NUMBERS = new Set(['10', '11', '14', '34', '70'])
const RULE_TRAILER_NUMBERS = new Set(['48', '53'])

// Words that are capitalised in a sentence without being a place or a name.
const CAP_STOP = new Set([
  'i', "i'm", "i'll", 'the', 'this', 'that', 'it', 'its', "it's", 'my', 'your', 'our', 'we', 'you', 'they', 'he', 'she', 'a', 'an',
  'and', 'but', 'so', 'if', 'when', 'what', 'where', 'how', 'let', 'just', 'not', 'of', 'yes', 'no', 'ok', 'okay', 'copy', 'sure',
  'today', 'tomorrow', 'tonight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'central', 'eastern', 'mountain', 'pacific', 'time', 'dat', 'am', 'pm', 'fcfs', 'tonu', 'cst', 'est', 'mst', 'pst', 'hold', 'one', 'two', 'three',
])
const STATE_NAMES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii',
  'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']
const PLACE_CUE = /\b(?:[Tt]o|[Ff]rom|[Ii]n|[Ii]nto|[Nn]ear|[Aa]t|[Oo]ut of)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})/g
const NO_COMMODITY = 'commodity unknown: check for a literal load type'
const RULE_CONTEXT = /rule|limit|reset|\brest\b|legal|\bhos\b|maximum|\bmax\b/
const EXTRA_REGIONS = /(?<![A-Za-z])(?:mid-?west|north-?east|south-?west|north-?west|west coast|east coast|gulf coast|great plains|new england|rust belt|sun ?belt)(?![A-Za-z])/gi

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

// The capitalised words of a phrase up to the first word that is not a name.
function placeWords(phrase) {
  const out = []
  for (const w of phrase.split(/\s+/)) {
    if (CAP_STOP.has(w.toLowerCase().replace(/[.,]$/, ''))) break
    out.push(w)
  }
  return out
}

// 10/11/14/34/70 are the rules when joined to "hour" by a dash ("10-hour"),
// or when a rule word is beside them ("11 hours is the limit"); a bare
// "11 hours." is Grace's clock.
function ruleNumber(src, idx, len) {
  const n = src.slice(idx, idx + len)
  const after = src.slice(idx + len)
  if (RULE_TRAILER_NUMBERS.has(n) && RULE_TRAILER.test(after)) return true
  if (RULE_HOUR_NUMBERS.has(n) && RULE_HOURS.test(after)) {
    if (/^[-\u2010-\u2015\u2212]/.test(after)) return true
    return RULE_CONTEXT.test(src.slice(Math.max(0, idx - 40), idx + len + 40).toLowerCase())
  }
  return false
}

const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= eps

class Masker {
  constructor(text) {
    this.text = String(text ?? '')
    this.slots = []
    this.flags = []
  }

  flag(f) { if (!this.flags.includes(f)) this.flags.push(f) }

  put(name) {
    const i = this.slots.push(name) - 1
    return OPEN + String(i).split('').map(DIGIT).join('') + CLOSE
  }

  // Replace every match; fn(match...) returns the replacement text or null to leave it.
  sub(re, fn) {
    this.text = this.text.replace(re, (...args) => {
      const groups = typeof args[args.length - 1] === 'object' ? args.pop() : null
      void groups
      const r = fn(args)
      return r == null ? args[0] : r
    })
  }

  done() {
    return this.text.replace(SENTINEL, (_, d) => `{${this.slots[Number([...d].map((c) => c.charCodeAt(0) - 0xE010).join(''))]}}`)
  }
}

function firstName(full) {
  const f = String(full ?? '').trim().split(/\s+/)[0]
  return f && f.length >= 3 ? f : null
}

// The facts a text may be templated with, gathered once.
function knowns(facts, said) {
  const f = facts ?? {}
  const d = f.driver ?? {}
  const perMile = []
  const rpm = f.rpm ?? (f.rate != null && f.miles ? f.rate / f.miles : null)
  perMile.push(['rate_per_mile', rpm])
  perMile.push(['ceiling_per_mile', f.ceiling != null && f.miles ? f.ceiling / f.miles : null])
  perMile.push(['origin_market', f.market?.origin?.value ?? null])
  perMile.push(['dest_market', f.market?.dest?.value ?? null])
  perMile.push(['national_market', f.market?.national ?? null])
  const totals = [
    ['rate', f.rate], ['ceiling', f.ceiling], ['detention_rate', f.terms?.detention],
    ['tonu', f.terms?.tonu], ['layover', f.terms?.layover], ['owed', d.owedUsd],
  ]
  return { f, d, perMile, totals }
}

function wordsNear(text, index, length, before = 30, after = 20) {
  return {
    before: text.slice(Math.max(0, index - before), index).toLowerCase(),
    after: text.slice(index + length, index + length + after).toLowerCase(),
  }
}

const KEYWORDS = {
  detention_rate: /detention|\/\s?hr|per hour|an hour|hourly/,
  tonu: /tonu|cancel/,
  layover: /layover|overnight|per day|a day|\/\s?day/,
  rate: /posted|all-in|all in|linehaul|total/,
  ceiling: /ceiling/,
  owed: /owed|settlement/,
}

// How far (in characters) the nearest keyword is from the figure, looking
// at the words just before and just after it; null when none is there.
function keywordDistance(re, w) {
  if (!re) return null
  const g = new RegExp(re.source, 'gi')
  const found = []
  let m
  while ((m = g.exec(w.before)) !== null) found.push(w.before.length - (m.index + m[0].length))
  const after = new RegExp(re.source, 'i').exec(w.after)
  if (after) found.push(after.index)
  return found.length ? Math.min(...found) : null
}

function timeKey(h, m, ap) {
  return `${Number(h)}:${m ?? '00'}${String(ap).toUpperCase()}M`
}

// text -> { text, flags }. role 'reply' (a chat's answer) or 'line' (the
// dispatcher's message); `said` from saidFrom(). Nothing is guessed: a
// figure no fact explains becomes a generic placeholder and a flag.
export function templateText(text, facts, { role = 'reply', said = null } = {}) {
  const s = said ?? saidFrom([])
  const { f, d, perMile, totals } = knowns(facts, s)
  const mk = new Masker(text)
  const side = f.side ?? null

  // 1. Identifiers
  mk.sub(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi, () => mk.put('email'))
  mk.sub(/\b(m\.?c\.?\s*(?:#|no\.?|number|:)?\s*(?:is|:)?\s*-?\s*)(\d{5,7})\b/gi, ([, lead]) => `${lead}${mk.put('mc')}`)
  mk.sub(/\b(\d{5,7})(\s+is\s+(?:the|my|our)\s+m\.?c\b)/gi, ([, , tail]) => `${mk.put('mc')}${tail}`)
  mk.sub(/^(\s*#?)(\d{5,7})(\s*)$/, ([, a, , b]) => `${a}${mk.put('mc')}${b}`)
  if (s.mc) mk.sub(new RegExp(`(?<![\\d])${esc(s.mc)}(?![\\d])`, 'g'), () => mk.put('mc'))
  for (const t of new Set([s.truckNumber, d.truckId].filter(Boolean))) {
    mk.sub(new RegExp(word(t), 'gi'), () => mk.put('truck_number'))
  }
  if (d.load?.id) mk.sub(new RegExp(word(d.load.id), 'g'), () => mk.put('load_id'))

  // 2. Names: full, then first
  const full = [
    [f.brokerContact, 'broker_name'], [f.brokerCompany, 'broker_company'],
    [d.name, 'driver_name'], [s.driverName, 'driver_name'],
    [d.carrier, 'carrier_name'], [f.carrier, 'carrier_name'], [s.company, 'carrier_name'],
    [s.dispatcher, 'dispatcher_name'],
  ].filter(([v]) => v).sort((a, b) => b[0].length - a[0].length)
  for (const [v, name] of full) mk.sub(new RegExp(word(v), 'gi'), () => mk.put(name))
  const taken = new Set([s.dispatcher].filter(Boolean).map((x) => x.toLowerCase()))
  for (const [v, name] of [[f.brokerContact, 'broker_name'], [d.name, 'driver_name'], [s.driverName, 'driver_name']]) {
    const first = firstName(v)
    if (first && !taken.has(first.toLowerCase())) mk.sub(new RegExp(word(first), 'gi'), () => mk.put(name))
  }

  // 2b. The commodity
  if (f.commodity) {
    const variants = [...new Set([f.commodity, f.commodity.split(/\s+(?:in|on|for|of)\s+/i)[0]])].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)
    for (const v of variants) mk.sub(new RegExp(`(?<![A-Za-z0-9])${loose(v)}s?(?![A-Za-z0-9])`, 'gi'), () => mk.put('commodity'))
  } else if (side === 'broker' && /\b(?:commodity (?:is|=)|hauling|carrying|loaded with)\s+[a-z]/i.test(mk.text)) {
    mk.flag(NO_COMMODITY)
  }

  // 3. Per-mile figures
  mk.sub(PER_MILE, (args) => {
    const [, dollar, figure, unit] = args
    const v = Number(figure)
    const idx = args[args.length - 2]
    const src = String(args[args.length - 1])
    const marked = Boolean(unit) || (Boolean(dollar) && v < 20) || (/^\d\.\d{2}$/.test(figure) && v >= 1)
    const hits = perMile.filter(([, x]) => near(v, x, 0.011)).map(([n]) => n)
    if (hits.length === 0) {
      if (!marked || v < 0.5) return null
      if (s.perMile.some((x) => near(v, x, 0.011))) return mk.put('their_figure') + (unit ?? '')
      mk.flag(`unmatched per-mile figure: ${figure}`)
      return mk.put('per_mile') + (unit ?? '')
    }
    let pick = hits
    if (pick.length > 1) {
      // A region or "national" beside the figure decides which market it is.
      const w = wordsNear(src, idx, args[0].length, 40, 40)
      const around = `${w.before} ${w.after}`
      const byWord = pick.filter((n) => {
        if (n === 'national_market') return /national|nationwide/.test(around)
        const region = n === 'origin_market' ? f.market?.origin?.region : n === 'dest_market' ? f.market?.dest?.region : null
        return Boolean(region) && around.includes(region.toLowerCase())
      })
      if (byWord.length === 1) pick = byWord
      else mk.flag(`ambiguous per-mile figure ${figure}: ${pick.join(' | ')}`)
    }
    return mk.put(pick[0]) + (unit ?? '')
  })

  // 4. Totals
  mk.sub(MONEY, (args) => {
    const [whole, a, k, b] = args
    const v = Number((a ?? b).replace(/,/g, '')) * (k ? 1000 : 1)
    if (!Number.isFinite(v)) return null
    const idx = args[args.length - 2]
    const src = String(args[args.length - 1])
    let name
    const hits = totals.filter(([, x]) => x != null && near(v, x, 0.5)).map(([n]) => n)
    if (role === 'line' && s.dollars.some((x) => near(v, x, 0.5))) name = 'their_ask'
    else if (hits.length === 1) name = hits[0]
    else if (hits.length > 1) {
      // Two facts share the figure: the nearest keyword decides, else flag.
      const w = wordsNear(src, idx, whole.length)
      const scored = hits.map((n) => [n, keywordDistance(KEYWORDS[n], w)]).filter(([, dist]) => dist != null).sort((x, y) => x[1] - y[1])
      if (scored.length > 0 && (scored.length === 1 || scored[0][1] < scored[1][1])) name = scored[0][0]
      else { name = hits[0]; mk.flag(`ambiguous $${v}: ${hits.join(' | ')}`) }
    } else if (s.dollars.some((x) => near(v, x, 0.5))) name = 'their_ask'
    else if (side === 'broker' && f.rate != null && v > f.rate) { name = 'counter'; mk.flag('counter figure') }
    else { name = 'amount'; mk.flag(`unmatched money: ${whole.trim()}`) }
    return mk.put(name)
  })

  // 5. Miles
  let deadhead = null
  try {
    if (f.side === 'broker' && f.origin && s.truckCity) {
      deadhead = truckFacts({
        texts: s.texts,
        posting: { originCity: f.origin.city, originState: f.origin.state, pickupAt: null },
      })?.miles ?? null
    }
  } catch { deadhead = null }
  const mileFacts = [
    ['miles', f.miles], ['offer_miles', f.offer?.miles], ['load_miles', d.load?.miles], ['deadhead_miles', deadhead],
  ]
  mk.sub(MILES_FIG, (args) => {
    const [whole, figure] = args
    const v = Number(figure.replace(/,/g, ''))
    const hits = mileFacts.filter(([, x]) => x != null && v === x).map(([n]) => n)
    let name = hits[0] ?? (s.miles.includes(v) ? 'their_miles' : null)
    if (!name) { mk.flag(`unmatched miles: ${figure}`); return null }
    if (hits.length > 1) mk.flag(`ambiguous miles ${figure}: ${hits.join(' | ')}`)
    return whole.replace(figure, mk.put(name))
  })

  // 6. Weight, fuel, hours, free hours, temperature
  if (f.weightLbs != null) {
    mk.sub(/(?<![\d.,])(\d[\d,]*)(\s*(?:lbs?|pounds)\b)/gi, ([, n, unit]) => (Number(n.replace(/,/g, '')) === f.weightLbs ? mk.put('weight_lbs') + unit : null))
  }
  if (d.fuelPct != null) mk.sub(/(?<![\d.])(\d{1,3})(\s*%)/g, ([, n, pct]) => (Number(n) === d.fuelPct ? mk.put('fuel_pct') + pct : null))
  const hoursNow = d.hoursLeft != null ? parseInt(d.hoursLeft, 10) : null
  const free = f.terms?.freeHours ?? null
  const freeHit = (n) => {
    if (free != null && asNumber(n) === free) return true
    mk.flag(`unmatched free hours: ${n}`)
    return false
  }
  mk.sub(new RegExp(`\\b(${NUM_WORD})(\\s+(?:hours?|hrs?)\\s+free)\\b`, 'gi'), ([, n, rest]) => (freeHit(n) ? mk.put('free_hours') + rest : null))
  mk.sub(new RegExp(`\\b(${NUM_WORD})(\\s+free\\s+(?:hours?|hrs?))\\b`, 'gi'), ([, n, rest]) => (freeHit(n) ? mk.put('free_hours') + rest : null))
  mk.sub(new RegExp(`\\b((?:after|first)\\s+(?:the\\s+first\\s+)?)(${NUM_WORD})(\\s+free)?(\\s+(?:hours?|hrs?)\\b)`, 'gi'), ([, lead, n, fr, rest]) => {
    if (free != null && asNumber(n) === free) return lead + mk.put('free_hours') + (fr ?? '') + rest
    if (fr || side === 'broker') mk.flag(`unmatched free hours: ${n}`)
    return null
  })
  if (hoursNow != null) {
    mk.sub(/(?<![\d.])(\d{1,2})\s*h(?:ours?|rs?)?(?:\s*\d{1,2}\s*m(?:in)?)?\b/gi, (args) => {
      const [whole, n] = args
      const idx = args[args.length - 2]
      const src = String(args[args.length - 1])
      if (Number(n) !== hoursNow) return null
      const w = wordsNear(src, idx, whole.length, 30, 30)
      const cue = /left|remain|clock|driving time/.test(`${w.before} ${w.after}`)
      return cue || (side === 'driver' && !ruleNumber(src, idx, n.length)) ? mk.put('hours_left') : null
    })
  }
  mk.sub(/(?<![\d])-?(\d{1,3})\s*(?:°\s*F\b|degrees\b)/gi, () => mk.put('temp_f'))

  // 7. Times of day
  const timeFacts = [['pickup_time', f.pickup], ['delivery_time', f.delivery], ['earliest', f.offer?.earliest], ['pickup_said', f.offer?.pickupSaid]]
    .map(([n, v]) => {
      const m = /\b(\d{1,2}):(\d{2})\s?([AP])M\b/i.exec(String(v ?? ''))
      return m ? [n, timeKey(m[1], m[2], m[3])] : null
    }).filter(Boolean)
  mk.sub(/(?<![\d:])(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b/gi, ([whole, h, m, ap]) => {
    const key = timeKey(h, m, ap)
    const hit = timeFacts.find(([, k]) => k === key)
    if (hit) return mk.put(hit[0])
    mk.flag(`unmatched time: ${whole.trim()}`)
    return mk.put('time')
  })

  // 8. Cities
  const places = [
    [f.origin, 'origin_city'], [f.dest, 'dest_city'],
    [d.city ? { city: d.city, state: d.state } : null, 'driver_city'],
    [d.home && !(d.home.city === d.city && d.home.state === d.state) ? d.home : null, 'home_city'],
    [d.load?.origin, 'load_origin'], [d.load?.dest, 'load_dest'],
    [f.offer?.city ? { city: f.offer.city, state: f.offer.state } : null, 'offer_city'],
    [s.truckCity, 'truck_city'],
  ].filter(([p]) => p?.city)
  const byPlace = new Map()
  for (const [p, name] of places) {
    const key = `${p.city.toLowerCase()}|${p.state ?? ''}`
    if (!byPlace.has(key)) byPlace.set(key, { ...p, names: [] })
    byPlace.get(key).names.push(name)
  }
  for (const p of [...byPlace.values()].sort((a, b) => b.city.length - a.city.length)) {
    const st = p.state ? `(?:,\\s*${ci(p.state)}\\b|\\s${p.state}\\b)?` : ''
    mk.sub(new RegExp(`(?<![A-Za-z0-9])${ci(p.city)}(?![A-Za-z0-9])${st}`, 'g'), () => {
      let names = p.names
      if (names.length > 1) {
        const byRole = role === 'line' && names.includes('truck_city')
        const pref = byRole ? ['truck_city'] : names.filter((n) => n !== 'truck_city')
        if (!byRole) mk.flag(`ambiguous city ${p.city}: ${names.join(' | ')}`)
        names = pref.length ? pref : names
      }
      return mk.put(names[0])
    })
  }
  // A name one or two letters off a city the chat was given ("Cedar Raps").
  const known = [...byPlace.values()].map((p) => ({ city: p.city, name: p.names.find((n) => n !== 'truck_city') ?? p.names[0] }))
  mk.sub(PLACE_CUE, ([whole, phrase]) => {
    const words = placeWords(phrase)
    for (let k = words.length; k >= 1; k--) {
      const cand = words.slice(0, k).join(' ')
      const hit = known.find((c) => {
        const dist = levenshtein(cand.toLowerCase(), c.city.toLowerCase())
        return dist > 0 && dist <= (c.city.length >= 6 ? 2 : 1)
      })
      if (hit) {
        mk.flag(`fuzzy city: ${cand} ~ ${hit.city}`)
        const at = whole.indexOf(phrase)
        return whole.slice(0, at) + mk.put(hit.name) + whole.slice(at + cand.length)
      }
    }
    return null
  })
  const rest = placesIn(mk.text, { guard: false }).sort((a, b) => b.index - a.index)
  for (const c of rest) {
    mk.text = mk.text.slice(0, c.index) + mk.put('city') + mk.text.slice(c.end)
    mk.flag(`unmatched city: ${c.city}`)
  }
  for (const m of mk.text.matchAll(PLACE_CUE)) {
    const words = placeWords(m[1])
    if (words.length) mk.flag(`unmatched place: ${words.join(' ')}`)
  }

  // 9. Regions
  const regionNames = new Map()
  if (f.market?.origin?.region) regionNames.set(f.market.origin.region, 'origin_region')
  if (f.market?.dest?.region && !regionNames.has(f.market.dest.region)) regionNames.set(f.market.dest.region, 'dest_region')
  const regionKeys = [...new Set([...Object.keys(REGION_STATES), ...regionNames.keys()])].sort((a, b) => b.length - a.length)
  for (const key of regionKeys) {
    const re = new RegExp(`(?<![A-Za-z])(?<!(?:North|South)\\s)${key.replace(/s$/i, '').split(/[- ]+/).map(esc).join('[- ]?')}s?(?![A-Za-z])`, 'gi')
    mk.sub(re, () => {
      const name = regionNames.get(key)
      if (name) {
        if (f.market?.origin?.region === f.market?.dest?.region) mk.flag(`origin and reload are the same region: ${key}`)
        return mk.put(name)
      }
      if (key === 'California') return null
      mk.flag(`unmatched region: ${key}`)
      return mk.put('region')
    })
  }

  mk.sub(EXTRA_REGIONS, ([whole]) => { mk.flag(`unmatched region: ${whole}`); return mk.put('region') })

  // 10. Whatever digits are left
  const out = []
  let last = 0
  const src = mk.text
  for (const m of src.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const after = src.slice(m.index + m[0].length)
    void after
    if (ruleNumber(src, m.index, m[0].length)) continue
    out.push(src.slice(last, m.index), mk.put('number'))
    mk.flag(`unmatched number: ${m[0]}`)
    last = m.index + m[0].length
  }
  out.push(src.slice(last))
  mk.text = out.join('')

  const done = mk.done()
  // A reply that describes the load, with no commodity fact to check it against.
  if (side === 'broker' && role === 'reply' && !f.commodity
    && (done.includes('{miles}') || (done.includes('{origin_city}') && done.includes('{dest_city}')) || /{miles} mi,? w/.test(done))) {
    mk.flag(NO_COMMODITY)
  }
  // Last look: anything that still reads like this load's own data.
  const bare = done.replace(/\{[a-z_]+\}/g, ' ')
  const leaks = new Set()
  for (const m of bare.matchAll(/\d+(?:[.,]\d+)*/g)) if (!ruleNumber(bare, m.index, m[0].length)) leaks.add(m[0])
  if (bare.includes('$')) leaks.add('$')
  for (const c of placesIn(bare, { guard: false })) leaks.add(c.city)
  for (const n of STATE_NAMES) if (new RegExp(`(?<![A-Za-z])${n}(?![A-Za-z])`).test(bare)) leaks.add(n)
  const names = [f.brokerContact, f.brokerCompany, d.name, d.carrier, f.carrier, s.company, s.dispatcher, s.driverName]
    .filter(Boolean).flatMap((v) => v.split(/\s+/)).filter((w) => w.length >= 4 && /^[A-Z]/.test(w))
  for (const w of new Set(names)) if (new RegExp(`(?<![A-Za-z])${esc(w)}(?![A-Za-z])`).test(bare)) leaks.add(w)
  for (const l of leaks) mk.flag(`possible leak: ${l}`)

  return { text: done, flags: mk.flags }
}

// -- Candidates ------------------------------------------------------------------------------

const stampAt = (stamp) => {
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/.exec(String(stamp ?? ''))
  return m ? `${m[1]}T${m[2]}:${m[3]}` : null
}

// One joined, graded turn -> a candidate example (classified and templated).
export function candidateFrom(j) {
  const { row, facts, grade } = j
  const side = facts.side
  const history = row.history ?? []
  const said = saidFrom([...dispatcherTexts(history), row.line])
  const sit = classify(row.line, { side, facts, history })
  const tpl = (t, role) => templateText(t, facts, { role, said })
  const line = tpl(row.line, 'line')
  const reply = tpl(String(row.reply).trim(), 'reply')
  let previous = null
  if (history.length >= 2 && history[history.length - 2]?.role === 'dispatcher' && history[history.length - 1]?.role !== 'dispatcher') {
    const pl = history[history.length - 2]
    const pr = history[history.length - 1]
    // The earlier exchange is templated with only what had been said by then.
    const earlier = saidFrom(dispatcherTexts(history))
    const pLine = templateText(String(pl.content ?? ''), facts, { role: 'line', said: earlier })
    const pReply = templateText(String(pr.content ?? ''), facts, { role: 'reply', said: earlier })
    previous = { line: pLine.text, reply: pReply.text, flags: [...pLine.flags, ...pReply.flags] }
  }
  const earlierFlags = previous?.flags ?? []
  const flags = [...new Set([...(facts.flags ?? []), ...j.flags, ...line.flags, ...reply.flags, ...earlierFlags])]
  return {
    id: j.id,
    source: j.source,
    side,
    type: sit.primary,
    secondary: sit.secondary,
    detail: sit.detail,
    line: line.text,
    reply: reply.text,
    previous,
    rawLine: row.line,
    rawReply: String(row.reply).trim(),
    grade: { grade: grade.grade, by: grade.by, note: grade.note, at: grade.at },
    human: isHumanGrader(grade.by),
    gradeHistory: j.history.map((g) => ({ grade: g.grade, by: g.by, at: g.at })),
    flags,
    templateFlags: [...new Set([...(facts.flags ?? []), ...line.flags, ...reply.flags, ...earlierFlags])],
    findings: row.findings ?? [],
    promptVersion: row.promptVersion ?? null,
    at: row.at ?? stampAt(row.stamp),
    alsoIn: [],
  }
}

const normalize = (t) => String(t).toLowerCase().replace(/[^a-z0-9{}_ ]+/g, ' ').replace(/\s+/g, ' ').trim()
const tokens = (t) => new Set(normalize(t).split(' ').filter(Boolean))
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  let both = 0
  for (const x of a) if (b.has(x)) both += 1
  return both / (a.size + b.size - both)
}
export const NEAR_DUPLICATE = 0.85

const rankOf = (c) => (c.flags.includes('whole-chat grade') ? 2 : c.flags.some((x) => x.startsWith('regraded')) ? 1 : 0)

// Best first: not regraded / whole-chat, human grader, no automatic findings,
// fewer templating flags, current prompt version, newer, shorter reply.
export function compareCandidates(a, b, currentVersions = new Set()) {
  return rankOf(a) - rankOf(b)
    || Number(b.human) - Number(a.human)
    || Number(a.findings.length > 0) - Number(b.findings.length > 0)
    || a.templateFlags.length - b.templateFlags.length
    || Number(currentVersions.has(b.promptVersion)) - Number(currentVersions.has(a.promptVersion))
    || String(b.at ?? '').localeCompare(String(a.at ?? ''))
    || a.reply.length - b.reply.length
    || a.id.localeCompare(b.id)
}

// Per side and situation: sort, drop exact and near-identical examples (the
// best one stays, the others are recorded in its alsoIn), keep `top`.
// Returns [{ side, type, yes, shown: [candidate] }] in SITUATION_TYPES order.
export function rankAndDedupe(candidates, { top = 8, currentVersions = [] } = {}) {
  const current = new Set(currentVersions)
  const groups = new Map()
  for (const c of candidates) {
    const key = `${c.side}|${c.type}`
    if (!groups.has(key)) groups.set(key, { side: c.side, type: c.type, list: [] })
    groups.get(key).list.push(c)
  }
  const out = []
  for (const g of groups.values()) {
    const sorted = [...g.list].sort((a, b) => compareCandidates(a, b, current))
    const kept = []
    for (const c of sorted) {
      const text = `${c.line} || ${c.reply}`
      const norm = normalize(text)
      const tok = tokens(text)
      const twin = kept.find((k) => k._norm === norm || jaccard(k._tok, tok) >= NEAR_DUPLICATE)
      if (twin) { twin.alsoIn.push(c.id); continue }
      kept.push(Object.assign({ ...c, alsoIn: [] }, { _norm: norm, _tok: tok }))
    }
    out.push({
      side: g.side, type: g.type, yes: g.list.length,
      shown: kept.slice(0, top).map(({ _norm, _tok, ...c }) => c),
    })
  }
  const order = (t) => SITUATION_TYPES.indexOf(t)
  return out.sort((a, b) => a.side.localeCompare(b.side) || order(a.type) - order(b.type))
}

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1 }

// joinGraded's result -> everything the report shows.
export function buildBank(join, { gradesRead = 0, uniqueIds = null, top = 8, currentVersions = [] } = {}) {
  const candidates = join.joined.map(candidateFrom)
  const groups = rankAndDedupe(candidates, { top, currentVersions })
  const perSource = {}
  const ensure = (src) => (perSource[src] ??= { joined: 0, unjoined: 0, excluded: 0 })
  for (const j of join.joined) ensure(j.source).joined += 1
  for (const u of join.unjoined) ensure(parseGradeId(u.id)?.source ?? 'unknown').unjoined += 1
  for (const e of join.excluded) ensure(e.source).excluded += 1
  const excludedByReason = {}
  for (const e of join.excluded) bump(excludedByReason, e.reason)
  const byType = {}
  for (const c of candidates) {
    byType[c.type] ??= { broker: 0, driver: 0 }
    byType[c.type][c.side] += 1
  }
  const unmatched = candidates.filter((c) => c.flags.some((x) => x.startsWith('unmatched')))
  return {
    meta: {
      gradesRead,
      uniqueIds: uniqueIds ?? join.joined.length + join.unjoined.length + join.excluded.length,
      joined: join.joined.length,
      unjoined: join.unjoined.length,
      excluded: join.excluded.length,
      perSource,
      excludedByReason,
      byType,
      candidates: candidates.length,
      withUnmatchedFlags: unmatched.length,
      withAnyFlag: candidates.filter((c) => c.flags.length > 0).length,
      top,
    },
    groups,
    unjoined: join.unjoined,
    excluded: join.excluded,
  }
}

// -- Output ----------------------------------------------------------------------------------------

export function renderJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`
}

const code = (t) => `\`${String(t).replace(/`/g, "'").split(/\s*\n\s*/).filter(Boolean).join(' / ')}\``

export function renderMarkdown(result) {
  const { meta, groups } = result
  const L = []
  const say = (t = '') => L.push(t)

  say('# Example bank')
  say()
  say('Chat turns graded yes, grouped by the situation the dispatcher line puts the chat in, with the load\'s numbers and names replaced by {placeholders}. Flags mark every figure that could not be matched to a fact.')
  say()
  say('Grade notes are not templates -- never copy figures from them.')
  say()
  say('## Counts')
  say()
  say(`- Grades read: ${meta.gradesRead} lines, ${meta.uniqueIds} unique ids`)
  say(`- Joined to a row and graded yes: ${meta.joined}; excluded: ${meta.excluded}; could not be joined: ${meta.unjoined}`)
  for (const [src, c] of Object.entries(meta.perSource)) say(`- ${src}: joined ${c.joined}, excluded ${c.excluded}, unjoined ${c.unjoined}`)
  if (Object.keys(meta.excludedByReason).length) {
    say(`- Excluded by reason: ${Object.entries(meta.excludedByReason).map(([r, n]) => `${r} ${n}`).join('; ')}`)
  }
  say(`- Candidates still carrying an "unmatched" flag: ${meta.withUnmatchedFlags} of ${meta.candidates}; carrying any flag: ${meta.withAnyFlag}`)
  say()
  say('## Situations')
  say()
  say('| Situation | Broker (yes / shown) | Driver (yes / shown) |')
  say('|---|---|---|')
  const cell = (side, type) => {
    const g = groups.find((x) => x.side === side && x.type === type)
    return g ? `${g.yes} / ${g.shown.length}` : '-'
  }
  for (const type of SITUATION_TYPES) {
    if (groups.some((g) => g.type === type)) say(`| ${type} | ${cell('broker', type)} | ${cell('driver', type)} |`)
  }
  say()

  for (const g of groups) {
    say(`## ${g.side} / ${g.type} (${g.shown.length} of ${g.yes})`)
    say()
    for (const c of g.shown) {
      say(`### ${c.id}`)
      say()
      if (c.previous) {
        say(`- Earlier line: ${code(c.previous.line)}`)
        say(`- Earlier reply: ${code(c.previous.reply)}`)
      }
      say(`- Line: ${code(c.line)}`)
      say(`- Reply: ${code(c.reply)}`)
      say(`- Grade: ${c.grade.grade} by ${c.grade.by ?? 'unknown'}${c.grade.note ? ` -- ${c.grade.note}` : ''}`)
      if (c.gradeHistory.length > 1) say(`- Grade history: ${c.gradeHistory.map((x) => `${x.grade} (${x.by ?? '?'})`).join(' -> ')}`)
      if (c.secondary.length) say(`- Also: ${c.secondary.join(', ')}`)
      if (c.findings.length) say(`- Automatic findings: ${c.findings.join('; ')}`)
      if (c.flags.length) say(`- Flags: ${c.flags.join('; ')}`)
      if (c.alsoIn.length) say(`- Same as: ${c.alsoIn.join(', ')}`)
      say(`- Prompt version: ${c.promptVersion ?? 'unknown'}`)
      say()
    }
  }

  say('## Not joined')
  say()
  if (result.unjoined.length === 0) say('None.')
  for (const u of result.unjoined) say(`- ${u.id}: ${u.reason}`)
  say()
  return `${L.join('\n')}\n`
}

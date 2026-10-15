// A load the dispatcher mentions to the driver, read by code.
//
// Live runs of 2026-10-15 (chat:eval ED07, live:60-62): told "got a load
// pittsburgh to raleigh pu tmrw 3am" while Grace sat in Seattle, she said
// "Copy" and asked for the miles; asked later, she invented "about 2,500 mi,
// so roughly 45 hours driving" -- a drive with no rests, and a pickup she
// could not make by a day and a half, never mentioned. The prompt could
// not fix that: whether a pickup is reachable is arithmetic, and the model
// did not do it.
//
// So the code does it. From the dispatcher's own words: which city the
// pickup is in, and when; from the database: where Grace is and how many
// driving hours she has left. The result is handed to the prompt as a fact
// (driverChat.prompt.js, offerLines) -- the miles, the earliest she could
// legally be there, and whether that is before the pickup. The prompt
// still does not refuse anything: refusing a load is the dispatch rules'.
//
// Never a default: a city this list does not know gets NO distance, and
// the prompt is told to ask for the miles.
//
// Pure: text, rows and a clock in, facts out.

import { CITIES, findCity, roadMiles } from '../../../scripts/seed/cities.js'
import { legalTransitHours } from '../loads/whereabouts.js'
import { APP_TIMEZONE } from '../../constants/appClock.js'

// How dispatchers write the two cities they type shortest. Small on
// purpose: every entry is a guess about someone else's shorthand.
const ALIASES = Object.freeze({
  nyc: { city: 'New York', state: 'NY' },
  philly: { city: 'Philadelphia', state: 'PA' },
})

// "St. Louis" is also typed "st louis"; spaces may be several.
function namePattern(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '.' ? '\\.?' : `\\${ch}`)).replace(/\s+/g, '\\s+')
}

const NAMES = [...new Set([...CITIES.map((c) => c.city), ...Object.keys(ALIASES)])]
  .sort((a, b) => b.length - a.length) // "Kansas City" before "Kansas"
const NAME_RE = new RegExp(`(?<![A-Za-z])(${NAMES.map(namePattern).join('|')})(?![A-Za-z])`, 'gi')
// Directly after a city name: ", TX" or " tx".
const STATE_RE = /^,?\s+([A-Za-z]{2})(?![A-Za-z])/

const norm = (s) => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
const STATES = new Set(CITIES.map((c) => c.state))

// The cities named in a text, in order: [{ city, state, lat, lon, index,
// end }]. Whole words, any case; "dallas", "dallas tx" and "Dallas, TX" are
// one place. A name used by several cities (Portland, Springfield,
// Charleston) with no state beside it is skipped -- guessing the one the
// dispatcher meant would put a wrong number in front of the driver.
// `except` (a { city, state }) is left out: the place Grace already is.
export function placesIn(text, { except = null } = {}) {
  return scan(text).filter((c) => !c.ambiguous && !(except && c.city === except.city && c.state === except.state))
}

// Every city name in the text, the unresolvable ones marked `ambiguous`.
// pickupCity needs them: in "portland to dallas tx" the pickup is the
// Portland nobody could place, not the Dallas beside it.
function scan(text) {
  const src = String(text ?? '')
  const out = []
  for (const m of src.matchAll(NAME_RE)) {
    const word = norm(m[1])
    const alias = ALIASES[word]
    const rest = src.slice(m.index + m[0].length)
    const stateMatch = rest.match(STATE_RE)
    const stated = stateMatch ? stateMatch[1].toUpperCase() : null
    const sameName = CITIES.filter((c) => (alias ? c.city === alias.city && c.state === alias.state : norm(c.city) === word))
    // A two-letter word after the name counts as the state only if that
    // city exists there: "dallas to raleigh" has "to", "portland in the
    // morning" has "in" (Indiana), and neither is a state of those cities.
    const byState = stated && STATES.has(stated) ? sameName.find((c) => c.state === stated) : null
    const hit = byState ?? (sameName.length === 1 ? sameName[0] : null)
    if (!hit) { out.push({ ambiguous: true, index: m.index, end: m.index + m[0].length }); continue }
    out.push({ ...hit, index: m.index, end: m.index + m[0].length + (byState && stateMatch ? stateMatch[0].length : 0) })
  }
  return out
}

const KEYWORD_RE = /\b(?:loads?|pu|p\/u|pick ?up|picks? up|picking up)\b/gi
const NEAR_CHARS = 15
const LINK_RE = /^\s*(?:to|->|=>|→|-|–)\s*$/i

// The pickup city of a load the dispatcher is offering: the first of an
// "X to Y" pair, else the one city named next to "load" / "pu" /
// "pickup". null when none or when two compete -- not guessed.
export function pickupCity(text, { except = null } = {}) {
  const src = String(text ?? '')
  const all = scan(src)
  const sameAs = (c) => except && c.city === except.city && c.state === except.state

  for (let i = 0; i + 1 < all.length; i++) {
    if (LINK_RE.test(src.slice(all[i].end, all[i + 1].index))) return all[i].ambiguous || sameAs(all[i]) ? null : all[i]
  }

  const keywords = [...src.matchAll(KEYWORD_RE)].map((k) => ({ start: k.index, end: k.index + k[0].length }))
  const near = all.filter((c) => !sameAs(c) && keywords.some((k) => {
    const gap = k.start >= c.end ? k.start - c.end : c.index >= k.end ? c.index - k.end : 0
    return gap <= NEAR_CHARS
  }))
  // A name near the keyword that could not be placed competes too.
  if (near.some((c) => c.ambiguous)) return null
  const distinct = [...new Map(near.map((c) => [`${c.city}|${c.state}`, c])).values()]
  return distinct.length === 1 ? distinct[0] : null
}

// "got a <word> load": a place the list does not know, said as the
// pickup. These words before "load" describe the freight, not a place.
const NOT_A_PLACE = new Set([
  'new', 'next', 'good', 'great', 'nice', 'hot', 'big', 'short', 'long', 'little', 'heavy', 'light', 'fresh',
  'another', 'one', 'solid', 'decent', 'local', 'regional', 'reefer', 'flatbed', 'van', 'dry', 'hazmat',
  'tanker', 'step', 'deck', 'power', 'same', 'direct', 'team', 'rush', 'tight', 'bad', 'cheap', 'the',
  'your', 'ur', 'my', 'that', 'this', 'oversize', 'oversized', 'partial', 'full', 'ltl', 'drop', 'live',
  'paying', 'real', 'first', 'last', 'better', 'bigger', 'good', 'quick', 'easy', 'hard', 'other',
])
const UNKNOWN_PLACE_RE = /\b(?:got|gotta|have|has|found)\s+(?:an?\s+)?([a-z][a-z.]{2,})\s+load\b/i

function unknownPlace(text) {
  const m = String(text ?? '').match(UNKNOWN_PLACE_RE)
  if (!m) return null
  const word = m[1].toLowerCase().replace(/\.$/, '')
  return NOT_A_PLACE.has(word) || NAMES.some((n) => norm(n) === word) ? null : m[1]
}

// -- When the pickup is -------------------------------------------------------

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 }
const DAY_RE = /\b(today|tmrw|tmr|tomorrow|tomorow|(?:sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day|sday|nesday|rsday|urday)?)\b/i
const TIME_AMPM_RE = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\b\.?/i
const TIME_24H_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/

function zonedParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour), mm: Number(parts.minute), ss: Number(parts.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  }
}

// Wall-clock Y-M-D H:M on the company's clock -> the instant. Two passes so
// a date on the far side of a clock change still lands on the right hour.
function centralInstant(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm)
  const offsetAt = (ms) => { const z = zonedParts(ms); return Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm, z.ss) - Math.floor(ms / 1000) * 1000 }
  let ms = wall - offsetAt(wall)
  ms = wall - offsetAt(ms)
  return ms
}

// "tmrw 8am", "pu monday 3 am", "today 15:00" -> the instant on the
// company's (Central) clock, or null: a day with no hour, an hour with no
// day and anything unreadable are not guessed at. A weekday means its next
// occurrence, today's if that hour is still ahead.
export function pickupWhen(text, now = new Date()) {
  const src = String(text ?? '')
  const day = src.match(DAY_RE)
  if (!day) return null

  let hh
  let mm
  const ap = src.match(TIME_AMPM_RE)
  if (ap) {
    const h = Number(ap[1])
    if (h < 1 || h > 12) return null
    hh = (h % 12) + (ap[3].toLowerCase() === 'p' ? 12 : 0)
    mm = Number(ap[2] ?? 0)
  } else {
    const t = src.match(TIME_24H_RE)
    if (!t) return null
    hh = Number(t[1])
    mm = Number(t[2])
  }

  const word = day[1].toLowerCase()
  const today = zonedParts(now.getTime())
  const at = (daysAhead) => {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + daysAhead))
    return centralInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm)
  }
  if (word === 'today') return new Date(at(0))
  if (/^(tmrw|tmr|tomorrow|tomorow)$/.test(word)) return new Date(at(1))
  const ahead = (WEEKDAYS[word.slice(0, word.startsWith('tue') ? 3 : word.startsWith('thu') ? 3 : 3)] - today.weekday + 7) % 7
  const sameDay = at(ahead)
  return new Date(ahead === 0 && sameDay <= now.getTime() ? at(7) : sameDay)
}

// -- The facts the prompt is given ---------------------------------------------

// What the dispatcher's last words say about a load, against Grace's own
// day -- or null when no load is being offered.
//
//   { city, state, miles, fromCity, onLoad, earliestAt, pickupAt, makesIt }
//
//   miles       road miles from where she is (roadMiles, the number every
//               load is priced with); null = the place is not on the list
//               and no figure is given.
//   earliestAt  now + legalTransitHours(miles, her driving time left).
//   makesIt     earliestAt <= pickupAt; null without a pickup time.
//   onLoad      she is on a load: miles are from where it delivers, and
//               there is no earliestAt / makesIt. A load's eta_at is kept
//               on a compressed calendar (loads.repository.js) that is not
//               the wall clock, so no honest "can she be there" exists yet.
//
// `texts` are the dispatcher's recent messages, the one being answered
// last: a pickup time said one message earlier still counts (live:61).
export function offerFacts({ driver, load = null, texts, now = new Date() }) {
  const list = (texts ?? []).filter((t) => typeof t === 'string')
  const here = driver?.currentCity ? { city: driver.currentCity, state: driver.currentState } : null
  // Most recent message first: the load being talked about now.
  const recent = [...list].reverse()

  let place = null
  for (const t of recent) {
    place = pickupCity(t, { except: here })
    if (place) break
  }
  // The load she is already on, named: "ur on the NYC load" is not an offer.
  if (place && load && ((place.city === load.destinationCity && place.state === load.destinationState)
    || (place.city === load.originCity && place.state === load.originState))) place = null

  if (!place) {
    const name = recent.map(unknownPlace).find(Boolean)
    return name ? { city: name, state: null, miles: null, fromCity: null, onLoad: Boolean(load), earliestAt: null, pickupAt: null, makesIt: null } : null
  }

  const base = { city: place.city, state: place.state }
  if (load) {
    const from = findCity(load.destinationCity, load.destinationState)
    return { ...base, miles: from ? roadMiles(from, place) : null, fromCity: from ? `${from.city}, ${from.state}` : null, onLoad: true, earliestAt: null, pickupAt: null, makesIt: null }
  }

  const from = findCity(driver?.currentCity, driver?.currentState)
  if (!from) return { ...base, miles: null, fromCity: null, onLoad: false, earliestAt: null, pickupAt: null, makesIt: null }
  const miles = roadMiles(from, place)
  const earliestAt = new Date(now.getTime() + legalTransitHours(miles, driver.hosRemainingMin) * 3600e3)
  let pickupAt = null
  for (const t of recent) {
    pickupAt = pickupWhen(t, now)
    if (pickupAt) break
  }
  return { ...base, miles, fromCity: `${from.city}, ${from.state}`, onLoad: false, earliestAt, pickupAt, makesIt: pickupAt ? earliestAt.getTime() <= pickupAt.getTime() : null }
}

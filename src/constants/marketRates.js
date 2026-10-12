// What freight pays, by where it starts: DAT's published benchmarks.
//
// Until 2026-10-05 every posting's rate was a random draw from one band,
// $1.80-2.80/mi, scaled by an equipment multiplier nobody had a source
// for. A load out of Chicago and a load out of Miami were priced by the
// same die, so the one lesson the board exists to teach -- WHERE the
// truck ends up matters as much as what it is paid to get there -- could
// not be learned from it.
//
// Azizbek brought a market report on 2026-10-05 (AQSh Trucking Market
// Rate Hisoboti), built on DAT's weekly reports. Every number below was
// checked against DAT's own pages the same day:
//
//   Dry van  https://www.dat.com/blog/dry-van-report-falling-tonnage-tighter-market-as-the-supply-story-holds  (published 2026-09-28)
//   Reefer   https://www.dat.com/blog/reefer-report-rates-ease-as-produce-rush-cools-but-the-year-over-year-premium-holds  (published 2026-10-01)
//   Flatbed  https://www.dat.com/blog/flatbed-report-farm-iron-stacks-up-and-flatbed-demand-will-feel-it  (published 2026-09-28)
//   All-in   https://www.dat.com/trendlines  (October 2026 snapshot, as quoted in the report)
//
// What these numbers ARE: spot LINEHAUL paid to carriers, fuel excluded,
// averaged over every lane leaving a region in the week ending
// 2026-09-25. What they are NOT: a quote for any one lane. DAT says so,
// and so does the report (section 2): "Great Lakes $2.66/mi does not mean
// every lane out of Great Lakes pays exactly that."
//
// Pure data and arithmetic. No imports, no clock, no network.

export const MARKET_WEEK_ENDING = '2026-09-25'
export const MARKET_SOURCE = 'DAT Freight & Analytics'

// Equipment DAT reports. Step-deck, tanker and power-only are not in
// these reports, so they keep the old band (scripts/seed/validate.js)
// rather than borrowing a number that was measured for something else.
export const MARKET_EQUIPMENT = Object.freeze(['dry-van', 'reefer', 'flatbed'])

// National spot linehaul, $/mi, fuel excluded -- "averaged $2.17 per mile
// last week, minus fuel" and so on, from the three reports above.
export const NATIONAL_LINEHAUL = Object.freeze({ 'dry-van': 2.17, reefer: 2.71, flatbed: 2.59 })

// National all-in snapshot, $/mi, fuel included (DAT Trendlines, October
// 2026). Used for one thing only: the fuel-and-surcharge part of a rate,
// below.
export const NATIONAL_ALL_IN = Object.freeze({ 'dry-van': 3.15, reefer: 3.63, flatbed: 3.65 })

// Origin-region linehaul, $/mi, fuel excluded. Exactly the regions each
// report lists -- ten per equipment type, and not the same ten. A region
// missing from a list has no published number this week; it falls back
// to the national figure and says so (`source: 'national'`), rather than
// being filled in with a guess.
export const REGIONAL_LINEHAUL = Object.freeze({
  'dry-van': Object.freeze({
    'Great Lakes': 2.66,
    'Ohio River': 2.62,
    California: 2.49,
    'Upper Atlantic': 2.32,
    'Lower Atlantic': 2.27,
    'Lower Midwest': 2.26,
    Southeast: 2.19,
    Carolinas: 2.18,
    'South Central': 1.98,
    'Florida-So Georgia': 1.43,
  }),
  reefer: Object.freeze({
    'Upper Midwest': 3.60,
    'Great Lakes': 3.51,
    'Lower Midwest': 3.28,
    'Ohio River': 3.28,
    'Pacific Northwest': 3.17,
    California: 2.95,
    'Upper Atlantic': 2.85,
    Southeast: 2.41,
    'Lower Mountain': 2.39,
    'South Central': 2.24,
  }),
  flatbed: Object.freeze({
    'Ohio River': 3.22,
    Southeast: 3.21,
    Carolinas: 2.95,
    'Great Lakes': 2.85,
    'Upper Atlantic': 2.56,
    'Lower Midwest': 2.49,
    'South Central': 2.46,
    'Florida-So Georgia': 2.26,
    California: 2.20,
    'Lower Mountain': 1.66,
  }),
})

// Which states make up each region.
//
// NOT FROM DAT. None of the three reports defines its regions, and DAT
// does not publish the map with them. This is OUR approximation, by whole
// states, written down so it can be checked line by line -- by Azizbek's
// dispatchers first. Two places it is knowingly coarse:
//   - "Florida-So Georgia" is Florida only. South Georgia cannot be split
//     from the rest of Georgia at state level; Georgia goes to Southeast.
//   - "Upper Mountain" (MT, WY, CO) appears in none of this week's lists,
//     so every lane out of it prices from the national figure.
// Every state the city list uses is in exactly one region; a test holds
// that.
export const REGION_STATES = Object.freeze({
  'Pacific Northwest': Object.freeze(['WA', 'OR', 'ID']),
  California: Object.freeze(['CA']),
  'Lower Mountain': Object.freeze(['AZ', 'NM', 'NV', 'UT']),
  'Upper Mountain': Object.freeze(['MT', 'WY', 'CO']),
  'Upper Midwest': Object.freeze(['MN', 'WI', 'IA', 'ND', 'SD']),
  'Lower Midwest': Object.freeze(['MO', 'KS', 'NE']),
  'Great Lakes': Object.freeze(['IL', 'IN', 'MI']),
  'Ohio River': Object.freeze(['OH', 'KY', 'WV']),
  'Upper Atlantic': Object.freeze(['NY', 'NJ', 'PA', 'CT', 'MA', 'RI', 'VT', 'NH', 'ME']),
  'Lower Atlantic': Object.freeze(['VA', 'MD', 'DE', 'DC']),
  Carolinas: Object.freeze(['NC', 'SC']),
  Southeast: Object.freeze(['GA', 'AL', 'TN', 'MS']),
  'Florida-So Georgia': Object.freeze(['FL']),
  'South Central': Object.freeze(['TX', 'OK', 'AR', 'LA']),
})

const REGION_OF_STATE = new Map(
  Object.entries(REGION_STATES).flatMap(([region, states]) => states.map((s) => [s, region])),
)

export function regionOf(state) {
  return REGION_OF_STATE.get(String(state ?? '').toUpperCase()) ?? null
}

export function isMarketEquipment(equipmentType) {
  return MARKET_EQUIPMENT.includes(equipmentType)
}

// The linehaul benchmark for freight leaving `state`, with where the
// number came from. null for equipment DAT does not report.
export function outboundLinehaul(state, equipmentType) {
  if (!isMarketEquipment(equipmentType)) return null
  const region = regionOf(state)
  const regional = region ? REGIONAL_LINEHAUL[equipmentType][region] : undefined
  return regional !== undefined
    ? { region, linehaul: regional, source: 'regional' }
    : { region, linehaul: NATIONAL_LINEHAUL[equipmentType], source: 'national' }
}

// Fuel and surcharge, $/mi: the all-in snapshot minus the linehaul, at
// national level. A carrier is paid both; the board shows what the broker
// pays, which is both.
//
// The report warns (sections 1 and 13) that the two national figures are
// measured over different windows -- an October snapshot and the week
// ending 2026-09-25 -- so this difference is an estimate of the fuel
// part, not DAT's fuel surcharge table. It comes out at $0.92-1.06/mi
// across the three equipment types.
export function fuelPerMile(equipmentType) {
  if (!isMarketEquipment(equipmentType)) return null
  return Math.round((NATIONAL_ALL_IN[equipmentType] - NATIONAL_LINEHAUL[equipmentType]) * 100) / 100
}

// The all-in benchmark for freight leaving `state`: its region's linehaul
// plus the fuel part. null for equipment DAT does not report.
export function outboundAllIn(state, equipmentType) {
  const out = outboundLinehaul(state, equipmentType)
  if (!out) return null
  return Math.round((out.linehaul + fuelPerMile(equipmentType)) * 100) / 100
}

// The most a load may pay per mile -- migration 007's loads_rpm_band and
// 010's postings_rpm_band: rate_usd BETWEEN distance_mi * 1 AND
// distance_mi * 5. Mirrored, not chosen here; test/marketRates.test.js
// reads both migrations and fails if either moves.
export const DB_RPM_MIN = 1
export const DB_RPM_MAX = 5

// How far one lane sits from its region's benchmark.
//
// The report is explicit that a benchmark is an average and not a quote,
// and says nothing about how wide the lanes around it spread. So this is
// DERIVED from the one hard edge there is: the widest whole-percent
// spread that keeps the richest all-in benchmark in these tables (reefer
// out of Upper Midwest, $3.60 + fuel) inside the database's $5/mi
// ceiling. It works out to 10%. When dispatcher lane data arrives (the
// "known lanes" table), this should be replaced by what lanes really do.
export const LANE_SPREAD = (() => {
  let richest = 0
  for (const eq of MARKET_EQUIPMENT) {
    for (const linehaul of Object.values(REGIONAL_LINEHAUL[eq])) {
      richest = Math.max(richest, linehaul + fuelPerMile(eq))
    }
    richest = Math.max(richest, NATIONAL_LINEHAUL[eq] + fuelPerMile(eq))
  }
  return Math.floor((DB_RPM_MAX / richest - 1) * 100) / 100
})()

// The $/mi band one posting is drawn from: the origin's all-in benchmark,
// plus or minus LANE_SPREAD. null for equipment DAT does not report.
export function marketBand(originState, equipmentType) {
  const allIn = outboundAllIn(originState, equipmentType)
  if (allIn == null) return null
  return [allIn * (1 - LANE_SPREAD), allIn * (1 + LANE_SPREAD)]
}

// What a dispatcher can see about a lane's market: facts, not a verdict.
// Where it starts and what freight leaving there pays, where it ends and
// what freight leaving THERE pays -- the reload the truck will be looking
// for -- and the national figure to hold both against. All linehaul,
// fuel excluded, the way DAT publishes them. null when DAT does not
// report the equipment.
export function marketFacts({ originState, destinationState, equipmentType }) {
  const origin = outboundLinehaul(originState, equipmentType)
  const destination = outboundLinehaul(destinationState, equipmentType)
  if (!origin || !destination) return null
  return {
    equipmentType,
    weekEnding: MARKET_WEEK_ENDING,
    source: MARKET_SOURCE,
    national: NATIONAL_LINEHAUL[equipmentType],
    origin,
    destination,
  }
}

// -- The calendar ---------------------------------------------------------
//
// What the season usually does to freight, from the report's section 8
// (DAT's commentary). Words, not multipliers: the report has exactly one
// seasonal NUMBER -- reefer up about $0.50/mi from mid-April to July 4,
// 2026 -- and one number is not a curve. Multiplying October's benchmark
// by a guessed "April factor" would be inventing a market. So the season
// is told to the broker as a fact about the calendar, and the prices stay
// the week DAT measured.
const SEASON_TEXT = Object.freeze({
  winter: 'January-February: many markets soften seasonally, dry van and general freight most.',
  spring: 'March-April: freight picks up and produce season starts; reefer feels it first.',
  produce: 'April-July: produce and summer demand lift rates. In 2026 reefer rose about $0.50/mi from mid-April to July 4 (DAT).',
  peak: 'July: one of the seasonal peaks, reefer and dry van.',
  late: 'August-September: off the summer peak, though in 2026 the year-over-year premium held.',
  october: 'October: capacity is still tight and rates high, especially in the Midwest and on open-deck.',
  holiday: 'November-December: holiday, retail and year-end pressure can lift some lanes, dry van and reefer.',
})
const SEASON_OF_MONTH = Object.freeze([
  null, 'winter', 'winter', 'spring', 'produce', 'produce', 'produce',
  'peak', 'late', 'late', 'october', 'holiday', 'holiday',
])

// The month as the company's clock reads it (America/Chicago -- the same
// zone every screen and prompt uses, src/constants/appClock.js), not the
// server's.
function chicagoMonth(date) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric' }).format(date))
}

export function seasonNote(date = new Date()) {
  return SEASON_TEXT[SEASON_OF_MONTH[chicagoMonth(date)]]
}

// How old the benchmarks are, in whole days after the week they measure.
// A number from last month is still a fact -- about last month -- and the
// people using it should be told which.
export function benchmarkAgeDays(date = new Date()) {
  const end = Date.parse(`${MARKET_WEEK_ENDING}T23:59:59-05:00`)
  return Math.max(0, Math.floor((date.getTime() - end) / 86400000))
}

// Past this, the age is said out loud. Two weeks: DAT publishes weekly,
// so anything older has had two newer reports nobody brought in.
export const STALE_AFTER_DAYS = 14

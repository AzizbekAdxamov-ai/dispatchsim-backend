// What a run does to a truck: tires worn, oil owed, miles and gallons
// spread across the sim calendar. Every export here is a pure function —
// no db, no clock reads beyond what the caller passes in — so the fleet
// repositories (a later step) can call these and unit tests can pin down
// the arithmetic without a database.

import { AVG_MPG, FUEL_PRICE_PER_GAL } from '../modules/finance/finance.constants.js'

// ---------------------------------------------------------------------
// Source numbers
// ---------------------------------------------------------------------

// Steer-axle tires. Industry figures run 100,000–150,000 mi; this is the
// midpoint. https://cooktire.com/how-long-do-semi-truck-and-commercial-tires-last/
// (checked 2026-09-16)
export const TIRE_LIFE_FRONT_MI = 125000

// Drive-axle tires wear faster under load. 80,000–120,000 mi, midpoint.
// https://cooktire.com/how-long-do-semi-truck-and-commercial-tires-last/
// (checked 2026-09-16)
export const TIRE_LIFE_REAR_MI = 100000

// https://www.internationalusedtrucks.com/semi-truck-oil-change-intervals/
// https://www.lubezone.com/blog/semi-truck-oil-change-intervals/
// (checked 2026-09-16)
export const OIL_SERVICE_INTERVAL_MI = 25000

// $300–450 typical range, midpoint.
// https://www.epikafleet.com/blog/commercial-truck-oil-change-cost/
// (checked 2026-09-16)
export const OIL_SERVICE_COST_USD = 375

export const OIL_SERVICE_LABEL = 'Engine oil and filter'

// These two are NOT independently sourced — they are copies of the
// tdm_distance / tdm_gallons CHECK bounds in migration
// 009_truck_daily_metrics.sql. They live here (not derived from the SQL,
// SQL cannot be imported) so allocateRunDays/splitGallons have a number to
// work against. test/truckWear.test.js reads the migration file as text
// and asserts these two constants match its CHECK bounds, the same way
// test/openingBalance.test.js keeps a JS constant and a migration number
// in agreement. If migration 009's 900/250 ever change, that test fails
// until this file is updated to match.
export const DAILY_DISTANCE_CAP_MI = 900
export const DAILY_GALLONS_CAP = 250

// ---------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------

// Gallons a lane burns at the fleet's average mpg. Deliberately not
// rounded — callers that need a whole number (splitGallons, a ledger
// entry) round at the point they need it, so an intermediate round never
// eats a fraction that mattered downstream.
export function gallonsFor(miles) {
  return miles / AVG_MPG
}

// What a quantity of gallons costs at the pump. This is the same formula
// dispatch.service.js's fuelCostFor(distanceMi) uses on
// distanceMi / AVG_MPG — fuelCostFor is just fuelCostForGallons(gallonsFor(d))
// with the division and the round folded into one line. Kept as two
// functions (not one calling the other) because fuelCostFor predates this
// file and changing its shape is out of scope here; the equivalence is
// pinned down instead in truckWear.test.js by comparing the two across a
// range of distances, which is the proof that splitting the fuel charge
// between "already paid at dispatch" and "top-up at the pump" (see the
// plan's Q3) does not change what a mile costs.
export function fuelCostForGallons(gallons) {
  return Math.round(gallons * FUEL_PRICE_PER_GAL)
}

// How a run's gallons split between the truck's own tank and the pump.
//
// fuel_gallons on trucks is an integer column, so the tank can only drop
// by whole gallons -- fromTank has to be floored SOMEWHERE. The bug this
// exists to stop: applyRunToTruck used to floor fromTank only when writing
// it to the tank column, but computed ledgerGallons from the UNROUNDED
// fromTank. With a full tank (the common case) floor(fromTank) < fromTank,
// and the difference -- up to just under a gallon every single run --
// left the tank and never reached the ledger. It was not charged to
// anyone. Rounding once, here, and handing the ledger everything the tank
// did not cover closes that gap: fromTank + ledgerGallons === laneGallons
// always, by construction.
//
// An empty tank (truck.fuelGallons === 0) still returns fromTank: 0,
// ledgerGallons: laneGallons -- the same split the code produced before
// this existed, which is Q3's claim (see the comment above
// fuelCostForGallons) and is pinned by test.
export function splitTankAndPump(tankGallons, laneGallons) {
  const fromTank = Math.min(tankGallons, Math.floor(laneGallons))
  const ledgerGallons = laneGallons - fromTank
  return { fromTank, ledgerGallons }
}

// ---------------------------------------------------------------------
// Tires
// ---------------------------------------------------------------------

// Percentage points of tread a run consumes, counted at the odometer
// boundaries rather than on the run's own distance.
//
// tire_front_pct is an integer column. A run's own share of tread wear is
// almost always a fraction of a point — 500 mi against a 125,000 mi life
// is 0.4% — and (after - before) / life * 100, rounded, is 0 every single
// time. Every run would round its own damage down to nothing and a tire
// would never wear out. Flooring each ODOMETER READING to its own 1%
// bucket and subtracting is the same telescoping sum across many runs
// (bucket(500) - bucket(0), then bucket(1000) - bucket(500), …) but it
// never discards the fraction: the remainder always carries into the next
// run's calculation because it lives in the odometer, not in a per-run
// delta.
export function tirePointsWorn(odoBefore, odoAfter, lifeMi) {
  const unitMi = lifeMi / 100
  return Math.floor(odoAfter / unitMi) - Math.floor(odoBefore / unitMi)
}

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

// The odometer reading at which the NEXT oil service becomes due, if this
// run crossed a service-interval multiple; null if it didn't.
//
// Known gap: if a single run crosses more than one multiple of
// intervalMi (a very long haul, or a truck that missed several services),
// only the last multiple crossed is returned. That under-counts how many
// services are actually owed, but maintenance_records only needs "is one
// due right now" — see maint_one_per_truck_service_mileage in migration
// 032, which stops duplicate 'due' rows for the same (truck, service,
// due_mileage) rather than stacking them.
export function serviceDueMileage(odoBefore, odoAfter, intervalMi) {
  const before = Math.floor(odoBefore / intervalMi)
  const after = Math.floor(odoAfter / intervalMi)
  if (after > before) return after * intervalMi
  return null
}

// ---------------------------------------------------------------------
// Day-by-day allocation
// ---------------------------------------------------------------------

// 'YYYY-MM-DD' <-> a whole-number day count, done through Date.UTC so the
// arithmetic never touches the host's local time zone. truck_daily_metrics
// rows are sim days, and a sim day is just a label, not a moment — letting
// local time zone leak in would shift which calendar day a run's miles
// land on depending on where the process happens to run.
function toEpochDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

function fromEpochDay(epochDay) {
  const dt = new Date(epochDay * 86400000)
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// How far a window can grow past the minimum before allocateRunDays gives
// up. usedByDay is caller-supplied and nothing stops it from describing a
// truck that is booked solid for years; without a bound the search below
// would spin forever instead of failing loudly. ~10 sim years is far past
// anything a real backlog produces.
const MAX_WINDOW_GROWTH_DAYS = 3650

// Spreads roadMiles across the sim days ending at endSimDay, never putting
// more than capMi on a single day and respecting miles a day already has
// from usedByDay (Q2 in the plan).
//
// days = max(ceil(spanSimDays), ceil(roadMiles / capMi)) sets the smallest
// window that could possibly fit the run under the cap. Allocation then
// fills backward from endSimDay — the day the run finishes is the one
// that gets miles first, because that is the day the driver actually
// arrived. If the window (as reduced by usedByDay) can't hold roadMiles,
// the window grows by one more day at the START (endSimDay never moves)
// and the fill is retried. This never loses or overshoots a mile: the sum
// of the returned rows is always exactly roadMiles, and no row ever
// exceeds capMi.
//
// Only days that actually receive miles are returned.
export function allocateRunDays({ roadMiles, endSimDay, spanSimDays, usedByDay, capMi }) {
  if (!(roadMiles > 0)) return []

  const used = usedByDay || {}
  const endEpoch = toEpochDay(endSimDay)
  const minWindowDays = Math.max(1, Math.ceil(spanSimDays), Math.ceil(roadMiles / capMi))

  let windowDays = minWindowDays
  let startEpoch = endEpoch - windowDays + 1
  // caps is ordered oldest -> newest (start -> end).
  const caps = []
  let totalCapacity = 0
  for (let e = startEpoch; e <= endEpoch; e++) {
    const day = fromEpochDay(e)
    const cap = Math.max(0, capMi - (used[day] ?? 0))
    caps.push({ day, cap })
    totalCapacity += cap
  }

  while (totalCapacity < roadMiles) {
    if (windowDays - minWindowDays >= MAX_WINDOW_GROWTH_DAYS) {
      throw new Error(
        `allocateRunDays: could not fit ${roadMiles} mi ending ${endSimDay} within ` +
          `${windowDays} days even after growing the window — usedByDay likely leaves no room`,
      )
    }
    windowDays += 1
    startEpoch -= 1
    const day = fromEpochDay(startEpoch)
    const cap = Math.max(0, capMi - (used[day] ?? 0))
    caps.unshift({ day, cap })
    totalCapacity += cap
  }

  // Fill backward from the newest (last) day toward the oldest.
  let remaining = roadMiles
  const result = []
  for (let i = caps.length - 1; i >= 0 && remaining > 0; i--) {
    const { day, cap } = caps[i]
    const take = Math.min(cap, remaining)
    if (take > 0) {
      result.push({ day, distanceMi: take })
      remaining -= take
    }
  }

  return result.reverse() // chronological order
}

// ---------------------------------------------------------------------
// Fuel gallons per day
// ---------------------------------------------------------------------

// Splits totalGallons across the days in dayMiles, in proportion to miles
// driven that day, as whole gallons.
//
// Every day with dayMiles[i] > 0 must come back >= 1: migration 009's
// tdm_mpg_sane CHECK (distance_mi = 0 OR fuel_gallons > 0) rejects a row
// that moved but burned nothing. So each active day is reserved 1 gallon
// first; whatever is left (Math.round(totalGallons) - number of active
// days) is handed out by largest remainder, in proportion to miles.
//
// If totalGallons rounds to fewer gallons than there are active days
// (a handful of very short runs split across many days), the 1-gallon
// floor can't be honored AND the sum can't equal Math.round(totalGallons)
// at the same time — the CHECK constraint wins that trade, every active
// day gets exactly 1, and the reported sum is the day count, not the
// input total. That only happens for runs so short the difference is a
// few gallons; see truckWear.test.js for the exact case.
export function splitGallons(dayMiles, totalGallons) {
  const total = Math.round(totalGallons)
  const n = dayMiles.length
  const result = Array.from({ length: n }, () => 0)

  const activeIdx = []
  for (let i = 0; i < n; i++) {
    if (dayMiles[i] > 0) activeIdx.push(i)
  }
  if (activeIdx.length === 0) return result

  if (total <= activeIdx.length) {
    for (const i of activeIdx) result[i] = 1
    return result
  }

  const totalMiles = activeIdx.reduce((sum, i) => sum + dayMiles[i], 0)
  const remaining = total - activeIdx.length // already reserved 1 per active day
  const raw = activeIdx.map((i) => (dayMiles[i] / totalMiles) * remaining)
  const extra = raw.map((r) => Math.floor(r))
  const extraSum = extra.reduce((sum, x) => sum + x, 0)
  let leftover = remaining - extraSum

  const order = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; leftover > 0; k = (k + 1) % order.length) {
    extra[order[k].idx] += 1
    leftover -= 1
  }

  activeIdx.forEach((i, j) => {
    const gallons = 1 + extra[j]
    if (gallons > DAILY_GALLONS_CAP) {
      throw new Error(`splitGallons: day would need ${gallons} gal, over the ${DAILY_GALLONS_CAP} cap`)
    }
    result[i] = gallons
  })
  return result
}

// ---------------------------------------------------------------------
// Tank level
// ---------------------------------------------------------------------

// fuel_pct_end for each day, walking the tank down by dayGallons[i] in
// order. The percentage is never stored independently of the gallon
// count it comes from — it is always
// Math.round(gallonsRemaining / capacityGal * 100), clamped to [0, 100]
// so a rounding slip or an empty tank never produces a value the
// tdm_fuel_pct CHECK would reject.
export function walkFuelPct(startGallons, dayGallons, capacityGal) {
  let gallons = startGallons
  const result = []
  for (const g of dayGallons) {
    gallons -= g
    const pct = Math.round((gallons / capacityGal) * 100)
    result.push(Math.max(0, Math.min(100, pct)))
  }
  return result
}

// The arithmetic a delivered run applies to the truck that pulled it.
//
// Every test here exists because a specific implementation of it would
// pass a glance and fail a session. The mutation each one kills is named
// in the comment above it: change the code the way the mutation says and
// the test must go red.
//
// Pure functions only -- nothing here touches a database. The SQL the
// repos run is parse-checked by scripts/sql-check.js against the real
// schema; the numbers the SQL hardcodes are pinned to the migrations by
// the file-text tests at the bottom, in the same way
// test/openingBalance.test.js holds a JS constant and a migration number
// together.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  gallonsFor, fuelCostForGallons, splitTankAndPump, tirePointsWorn, serviceDueMileage,
  allocateRunDays, splitGallons, walkFuelPct,
  TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI, OIL_SERVICE_INTERVAL_MI,
  DAILY_DISTANCE_CAP_MI, DAILY_GALLONS_CAP,
} from '../src/constants/truckWear.js'
import { fuelCostFor } from '../src/modules/loads/dispatch.service.js'
import { AVG_MPG, FUEL_PRICE_PER_GAL } from '../src/modules/finance/finance.constants.js'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------
// tirePointsWorn
// ---------------------------------------------------------------------

test('tirePointsWorn: one full tire life is exactly 100 points', () => {
  assert.equal(tirePointsWorn(0, TIRE_LIFE_FRONT_MI, TIRE_LIFE_FRONT_MI), 100)
  assert.equal(tirePointsWorn(0, TIRE_LIFE_REAR_MI, TIRE_LIFE_REAR_MI), 100)
})

test('tirePointsWorn: 250 short runs wear 100 points, not 0', () => {
  // THE MUTATION: per-run rounding -- (odoAfter - odoBefore) / life * 100,
  // rounded per run -- is 0 for every 500-mi run and a tire would never
  // wear out. The odometer-bucket version telescopes: the fractions carry
  // in the odometer, not in a per-run delta.
  let front = 0
  let rear = 0
  let odo = 0
  for (let i = 0; i < 250; i += 1) {
    const after = odo + 500
    front += tirePointsWorn(odo, after, TIRE_LIFE_FRONT_MI)
    rear += tirePointsWorn(odo, after, TIRE_LIFE_REAR_MI)
    odo = after
  }
  // 125,000 mi of runs: exactly one steer-axle life.
  assert.equal(front, 100)
  // 125,000 mi against a 100,000-mi drive life: one life plus a quarter.
  assert.equal(rear, 125)
})

test('tirePointsWorn: boundary lands in the later bucket, not both', () => {
  // 1,250 mi per point on the steer axle. A run ENDING on the boundary
  // owns the point; the next run starts from zero progress.
  assert.equal(tirePointsWorn(0, 1249, TIRE_LIFE_FRONT_MI), 0)
  assert.equal(tirePointsWorn(0, 1250, TIRE_LIFE_FRONT_MI), 1)
  assert.equal(tirePointsWorn(1250, 2500, TIRE_LIFE_FRONT_MI), 1)
})

// ---------------------------------------------------------------------
// serviceDueMileage
// ---------------------------------------------------------------------

test('serviceDueMileage: fires once at the crossing, then goes quiet', () => {
  // THE MUTATION: `after >= before` (non-strict) or returning the interval
  // unconditionally would open a service on every run forever.
  assert.equal(serviceDueMileage(24999, 25001, OIL_SERVICE_INTERVAL_MI), 25000)
  assert.equal(serviceDueMileage(25001, 25002, OIL_SERVICE_INTERVAL_MI), null)
})

test('serviceDueMileage: a run ending exactly on the multiple is due', () => {
  assert.equal(serviceDueMileage(24999, 25000, OIL_SERVICE_INTERVAL_MI), 25000)
})

test('serviceDueMileage: one run crossing several intervals returns the LAST one', () => {
  // Known, documented gap: only the last multiple crossed comes back, so
  // two skipped services would open one record, not two. The unique index
  // (032) still guarantees that one is not doubled; the fleet manager sees
  // one overdue line where a stickler would see two. If this ever matters,
  // the fix is a loop in the caller -- not a change to this function's
  // contract.
  assert.equal(serviceDueMileage(24000, 51000, OIL_SERVICE_INTERVAL_MI), 50000)
})

// ---------------------------------------------------------------------
// fuel: Q3's "the money does not change" claim
// ---------------------------------------------------------------------

test('fuelCostForGallons(gallonsFor(d)) === fuelCostFor(d) for every lane length', () => {
  // THE MUTATION: any drift between the two formulas double-charges or
  // under-charges fuel the moment the tank model lands -- the delivery
  // charge and the refuel charge would disagree about what a gallon costs.
  // Q3's whole argument rides on these being the same number.
  for (let d = 25; d <= 3500; d += 25) {
    assert.equal(fuelCostForGallons(gallonsFor(d)), fuelCostFor(d), `distance ${d}`)
  }
})

test('gallonsFor is exact division -- rounding happens at the point of use', () => {
  assert.equal(gallonsFor(650), 100)
  assert.equal(gallonsFor(100), 100 / AVG_MPG)
})

// ---------------------------------------------------------------------
// splitTankAndPump: the fraction between floor(fromTank) and fromTank
// must land on the ledger, never vanish.
// ---------------------------------------------------------------------

test('splitTankAndPump: full tank -- nothing between tank and ledger is lost', () => {
  // THE MUTATION: reverting to Math.floor(laneGallons) -> laneGallons (the
  // un-rounded figure) in the ledger side reproduces the original bug --
  // fromTank + ledgerGallons stops equalling laneGallons whenever laneGallons
  // is not a whole number.
  const laneGallons = gallonsFor(500) // 500 mi, not a whole-gallon lane
  const { fromTank, ledgerGallons } = splitTankAndPump(10000, laneGallons)
  assert.equal(fromTank + ledgerGallons, laneGallons)
})

test('splitTankAndPump: fromTank is always a whole number', () => {
  // fuel_gallons is an integer column -- a fractional fromTank would fail
  // the INSERT, not just the arithmetic.
  const laneGallons = gallonsFor(500)
  const { fromTank } = splitTankAndPump(10000, laneGallons)
  assert.equal(fromTank, Math.floor(fromTank))
})

test('splitTankAndPump: empty tank -- Q3 is unchanged', () => {
  // Q3's claim: with an empty tank the ledger pays for the whole lane,
  // exactly as fuelCostFor(distanceMi) always has.
  const laneGallons = gallonsFor(500)
  const { fromTank, ledgerGallons } = splitTankAndPump(0, laneGallons)
  assert.equal(fromTank, 0)
  assert.equal(ledgerGallons, laneGallons)
})

test('splitTankAndPump: tank short of the lane -- it empties, the rest goes to the ledger', () => {
  const laneGallons = gallonsFor(500) // 76.923... gal
  const { fromTank, ledgerGallons } = splitTankAndPump(50, laneGallons)
  assert.equal(fromTank, 50)
  assert.equal(ledgerGallons, laneGallons - 50)
})

test('splitTankAndPump: fromTank + ledgerGallons === laneGallons across many distances', () => {
  // THE MUTATION this and the first test kill: rounding fromTank in one
  // place (the tank write) but not the other (the ledger charge) drops the
  // fraction between floor(fromTank) and fromTank -- it leaves the tank and
  // never reaches the ledger. Swept from a short local run to a long haul.
  for (let d = 25; d <= 3500; d += 25) {
    const laneGallons = gallonsFor(d)
    const { fromTank, ledgerGallons } = splitTankAndPump(10000, laneGallons)
    assert.equal(fromTank + ledgerGallons, laneGallons, `distance ${d}`)
  }
})

// ---------------------------------------------------------------------
// splitGallons
// ---------------------------------------------------------------------

test('splitGallons: every moving day burns at least 1 gallon', () => {
  // THE MUTATION: pure proportional rounding drives short days to 0, and
  // 009's tdm_mpg_sane CHECK (distance_mi = 0 OR fuel_gallons > 0)
  // rejects the row -- the delivery transaction dies on INSERT.
  const dayMiles = [1, 1, 1, 1, 1]
  const result = splitGallons(dayMiles, 2.5)
  for (const g of result) assert.ok(g >= 1, `day got ${g} gallons`)
})

test('splitGallons: the sum is exactly the rounded total', () => {
  // THE MUTATION: largest-remainder without the leftover pass loses or
  // invents a gallon, and sum(gallons) stops equalling distance/mpg.
  for (const total of [3.2, 17.9, 76.3, 152.7]) {
    const result = splitGallons([120, 480, 60], total)
    assert.equal(result.reduce((a, b) => a + b, 0), Math.round(total))
  }
})

test('splitGallons: idle days get nothing, the odd gallon goes to the earliest day', () => {
  // 450/900 each: the two moving days are symmetric, so the leftover from
  // the largest-remainder pass lands on the FIRST of them (stable sort on
  // equal fractions, round-robin from the start).
  const result = splitGallons([0, 450, 0, 450], 138.5)
  assert.deepEqual(result, [0, 70, 0, 69])
})

test('splitGallons: reserves one gallon per active day before sharing the rest', () => {
  // 10.4 gallons over two very unequal days: each gets 1, the remaining 8
  // split by miles, largest remainder first.
  const result = splitGallons([100, 700], 10.4)
  assert.equal(result.reduce((a, b) => a + b, 0), 10)
  assert.deepEqual(result, [2, 8])
})

// ---------------------------------------------------------------------
// allocateRunDays
// ---------------------------------------------------------------------

test('allocateRunDays: no day over the cap, sum exactly the road miles', () => {
  // THE MUTATION: spreading by the broker's window alone (0.5 days here)
  // puts 1,987 miles on one day and 009's tdm_distance CHECK rejects the
  // row. Also: any spill/round-trip loss in the fill loop breaks the
  // exact-sum assertion -- a lost mile is a lost odometer entry forever.
  const rows = allocateRunDays({ roadMiles: 1987, endSimDay: '2026-09-16', spanSimDays: 0.5, capMi: DAILY_DISTANCE_CAP_MI })
  assert.equal(rows.reduce((a, r) => a + r.distanceMi, 0), 1987)
  for (const r of rows) assert.ok(r.distanceMi <= 900, `day got ${r.distanceMi}`)
  assert.equal(rows[rows.length - 1].day, '2026-09-16')
})

test('allocateRunDays: borrows earlier days when the day is already booked', () => {
  // 500 mi already booked on the end day; an 800-mi run must flow around
  // it, not overwrite it and not break the cap.
  const rows = allocateRunDays({
    roadMiles: 800,
    endSimDay: '2026-09-16',
    spanSimDays: 1,
    usedByDay: { '2026-09-16': 500 },
    capMi: DAILY_DISTANCE_CAP_MI,
  })
  assert.equal(rows.reduce((a, r) => a + r.distanceMi, 0), 800)
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.distanceMi]))
  assert.equal(byDay['2026-09-16'], 400)
  assert.equal(byDay['2026-09-15'], 400)
})

test('allocateRunDays: miles land chronologically and the end day never moves', () => {
  const rows = allocateRunDays({ roadMiles: 2000, endSimDay: '2026-09-16', spanSimDays: 1, capMi: 900 })
  const days = rows.map((r) => r.day)
  assert.deepEqual([...days].sort(), days)
  assert.equal(days[days.length - 1], '2026-09-16')
})

test('allocateRunDays: refuses to spin forever on an overbooked truck', () => {
  // A truck booked solid for a simulated decade must fail LOUDLY, not
  // loop. THE MUTATION: dropping the growth bound turns a data bug into a
  // tick that never returns.
  //
  // The fixture must cover the WHOLE growth range: the window grows
  // backward from the end day, and any unbooked day inside it absorbs the
  // run honestly (a smaller fixture from 2020 would let the run spill into
  // 2019 and return, not throw). ~4,400 booked days back from the end day
  // outgrows the 3,650-day bound with room to spare.
  const usedByDay = {}
  const endMs = Date.UTC(2026, 8, 16)
  for (let i = 0; i < 4400; i += 1) {
    const d = new Date(endMs - i * 86400000)
    usedByDay[d.toISOString().slice(0, 10)] = 900
  }
  assert.throws(
    () => allocateRunDays({ roadMiles: 500, endSimDay: '2026-09-16', spanSimDays: 1, usedByDay, capMi: 900 }),
    /could not fit/,
  )
})

// ---------------------------------------------------------------------
// walkFuelPct
// ---------------------------------------------------------------------

test('walkFuelPct: tracks the tank down, never below 0, never above 100', () => {
  // THE MUTATION: computing pct independently of gallons is the exact
  // bug fleet pages already know -- gauge says one thing, math says
  // another. pct is DERIVED here, always.
  const pct = walkFuelPct(100, [30, 40, 40], 200)
  assert.deepEqual(pct, [35, 15, 0])
  for (const p of walkFuelPct(50, [10, 10, 10, 10, 10, 10], 200)) {
    assert.ok(p >= 0 && p <= 100)
  }
  assert.equal(walkFuelPct(300, [10], 200)[0], 100)
})

// ---------------------------------------------------------------------
// File-text pins: the JS constants and the SQL CHECKs must agree
// ---------------------------------------------------------------------

// THE MUTATION these three tests kill: changing a bound in JS without the
// migration (or the reverse). Nothing else in the codebase compares the
// two -- a drift ships green and dies later as a CHECK violation inside a
// tick transaction, at 2am, on a truck nobody touched.

test('DAILY_DISTANCE_CAP_MI and DAILY_GALLONS_CAP match migration 009 CHECKs', () => {
  const sql = readFileSync(join(here, '..', 'src', 'db', 'migrations', '009_truck_daily_metrics.sql'), 'utf8')
  const distance = sql.match(/tdm_distance CHECK \(distance_mi\s+BETWEEN 0 AND (\d+)\)/)
  const gallons = sql.match(/tdm_gallons\s+CHECK \(fuel_gallons BETWEEN 0 AND (\d+)\)/)
  assert.ok(distance, '009 ichida tdm_distance CHECK topilmadi')
  assert.ok(gallons, '009 ichida tdm_gallons CHECK topilmadi')
  assert.equal(Number(distance[1]), DAILY_DISTANCE_CAP_MI)
  assert.equal(Number(gallons[1]), DAILY_GALLONS_CAP)
})

test('the odometer cap in APPLY_RUN_TO_TRUCK_SQL matches trucks_odometer', () => {
  const trucksSql = readFileSync(join(here, '..', 'src', 'db', 'migrations', '006_trucks.sql'), 'utf8')
  const bound = trucksSql.match(/trucks_odometer\s+CHECK \(odometer_mi BETWEEN 0 AND (\d+)\)/)
  assert.ok(bound, '006 ichida trucks_odometer CHECK topilmadi')

  const fleetSql = readFileSync(join(here, '..', 'src', 'modules', 'fleet', 'fleet.sql.js'), 'utf8')
  const caps = [...fleetSql.matchAll(/least\((\d+), odometer_mi/g)].map((m) => Number(m[1]))
  assert.ok(caps.length > 0, 'fleet.sql.js ichida odometr cap topilmadi')
  for (const cap of caps) assert.equal(cap, Number(bound[1]))
})

test('the daily caps in ADD_DAILY_METRICS_SQL match migration 009 CHECKs', () => {
  const fleetSql = readFileSync(join(here, '..', 'src', 'modules', 'fleet', 'fleet.sql.js'), 'utf8')
  const distCaps = [...fleetSql.matchAll(/least\((\d+),\s*truck_daily_metrics\.distance_mi/g)].map((m) => Number(m[1]))
  const galCaps = [...fleetSql.matchAll(/least\((\d+),\s*truck_daily_metrics\.fuel_gallons/g)].map((m) => Number(m[1]))
  assert.ok(distCaps.length > 0 && galCaps.length > 0)
  for (const cap of distCaps) assert.equal(cap, DAILY_DISTANCE_CAP_MI)
  for (const cap of galCaps) assert.equal(cap, DAILY_GALLONS_CAP)
})

test('the fuel price is the one constant, not a copy', () => {
  // THE MUTATION: a hardcoded diesel price in the refuel path diverges
  // from the delivery path and every $/mi figure on the fleet page.
  assert.equal(typeof FUEL_PRICE_PER_GAL, 'number')
  assert.ok(FUEL_PRICE_PER_GAL > 0)
  // fuelCostFor and fuelCostForGallons must round the same way at the
  // boundary -- one gallon exactly.
  assert.equal(fuelCostForGallons(1), Math.round(FUEL_PRICE_PER_GAL))
})

test('every migrations file still parses as the tests read them', () => {
  // The file-text tests above read migrations as text; if a migration is
  // renamed the reads above throw ENOENT and this names the contract.
  const dir = join(here, '..', 'src', 'db', 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  assert.ok(files.includes('009_truck_daily_metrics.sql'))
  assert.ok(files.includes('006_trucks.sql'))
  assert.ok(files.includes('032_truck_wear.sql'))
})

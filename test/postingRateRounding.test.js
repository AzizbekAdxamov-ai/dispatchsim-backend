// Azizbek qarori 2026-11-06 — brokerlar yaxlit narx e'lon qiladi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { roundPostedRate, roundFuelSurcharge, buildPostingRows, buildNearCoverageRows } from '../scripts/seed/postings.js'
import { generateLoad } from '../scripts/seed/generate.js'
import { validateLoadItem } from '../scripts/seed/validate.js'
import { mulberry32 } from '../scripts/seed/build.js'
import { fuelPerMile } from '../src/constants/marketRates.js'

const round = (rateUsd, lowerBound, upperBound, fuelUsd) => roundPostedRate({ rateUsd, fuelUsd, lowerBound, upperBound })

// Kills: Math.round -> Math.floor or Math.ceil in roundPostedRate.
test('all-in rates round to the nearest multiple', () => {
  assert.equal(round(6308, 1000, 10000), 6300)
  assert.equal(round(901, 100, 4505), 900)
  assert.equal(round(643, 130, 650), 650)
})

// Kills: swapping the $50 and $25 steps, or moving the $1,000 threshold.
test('amounts below $1,000 use $25, from $1,000 use $50', () => {
  assert.equal(round(987, 100, 20000), 975)
  assert.equal(round(1037, 100, 20000), 1050)
  assert.equal(round(1012, 100, 20000), 1000)
})

// Note: changing `>=` to `>` at the threshold is an equivalent mutant: 1000 is
// a multiple of both steps, so it rounds to 1000 either way. Not claimed as a kill.

// Kills: rounding the linehaul while leaving the total uneven.
test('a split rate rounds the total and fuel', () => {
  assert.equal(round(6308, 1200, 6500, 437), 6300)
  assert.equal(roundFuelSurcharge(437, 6300), 450)
  assert.equal(round(3869, 100, 20000, 869), 3850)
})

// Kills: selecting rounding step from linehaul instead of total.
test('the split step is judged on the total', () => {
  assert.equal(round(1087, 300, 2000, 100), 1100)
})

// Kills: removing the inward floor, or clamping to the upper bound itself.
test('a non-round upper bound pulls the rate inward to a multiple', () => {
  assert.equal(round(663, 133, 665), 650)
})

// Kills: removing the inward ceil, or clamping to the lower bound itself.
test('a non-round lower bound pulls the rate inward to a multiple', () => {
  assert.equal(round(1312, 1312, 6560), 1350)
})

// Kills: allowing the rounded total above the upper bound.
test('split bounds apply to the total', () => {
  assert.equal(round(665, 133, 665, 52), 650)
})

// Kills: dropping the no-fit fallback (would return a figure outside the bounds).
test('when no multiple fits the bounds the clamped rate is kept', () => {
  assert.equal(round(110, 101, 120), 110)
})

const stepFor = (amount) => (amount >= 1000 ? 50 : 25)
const makeItems = () => {
  const rng = mulberry32(23)
  return Array.from({ length: 100 }, () => validateLoadItem(generateLoad(rng)).item)
}

// Kills: removing the call-site rounding in buildPostingRows, or rounding the
// total as all-in and deriving fuel from the rounded rate (linehaul not round).
test('generated postings have round totals and components within bounds', () => {
  const items = makeItems()
  const rows = buildPostingRows({ rng: mulberry32(24), postingItems: items, drivers: [], trucks: [], fleetEquipment: [] })
  assert.equal(rows.length, 100)
  assert.ok(rows.some((row) => row.rate_basis === 'linehaul-plus-fuel'))
  for (const row of rows) {
    const item = items.find((i) => i.originCity === row.origin_city && i.destinationCity === row.destination_city && i.broker === row.broker)
    const d = item.distanceMi
    const lower = Math.max(100, d)
    const upper = Math.min(20000, d * 5)
    const clamped = Math.min(upper, Math.max(lower, Math.round(d * item.ratePerMile)))
    const expectedFuel = row.rate_basis === 'linehaul-plus-fuel'
      ? Math.min(clamped - 1, Math.max(1, Math.round(d * fuelPerMile(item.equipmentType)))) : 0
    assert.equal(row.fuel_surcharge_usd, roundFuelSurcharge(expectedFuel, row.rate_usd))
    const amount = row.rate_usd - row.fuel_surcharge_usd
    assert.equal(row.rate_usd % stepFor(row.rate_usd), 0)
    assert.equal(amount % stepFor(row.rate_usd), 0, `${row.rate_usd} fuel ${row.fuel_surcharge_usd}`)
    assert.ok(row.rate_usd >= lower && row.rate_usd <= upper, `${row.rate_usd} in [${lower}, ${upper}]`)
  }
})

const counting = (next) => { const rng = () => { rng.calls += 1; return next() }; rng.calls = 0; return rng }
// Rate and fuel change together; all other generated data stays deterministic.
const fingerprint = (rows) => createHash('sha256').update(JSON.stringify(rows.map(({ rate_usd, fuel_surcharge_usd, ...rest }) => rest))).digest('hex')

// Kills: calling rng() inside roundPostedRate or at the call site (count and hash change).
test('rounding draws no random numbers', () => {
  const rng = counting(mulberry32(24))
  const rows = buildPostingRows({ rng, postingItems: makeItems(), drivers: [], trucks: [], fleetEquipment: [] })
  assert.equal(rng.calls, 500)
  assert.equal(fingerprint(rows), fingerprint(buildPostingRows({ rng: mulberry32(24), postingItems: makeItems(), drivers: [], trucks: [], fleetEquipment: [] })))

  const drivers = [{ id: 'a', current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' },
    { id: 'b', current_lat: 33.749, current_lon: -84.388, duty_status: 'on' }]
  const nearRng = counting(mulberry32(7))
  const near = buildNearCoverageRows({ rng: nearRng, drivers, brokerIds: new Map() })
  assert.equal(nearRng.calls, 140)
  assert.equal(near.length, 10)
  assert.equal(fingerprint(near), fingerprint(buildNearCoverageRows({ rng: mulberry32(7), drivers, brokerIds: new Map() })))
})

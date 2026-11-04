// Azizbek qarori 2026-11-06 — brokerlar yaxlit narx e'lon qiladi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { roundPostedRate, buildPostingRows, buildNearCoverageRows } from '../scripts/seed/postings.js'
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

// Kills: rounding the total instead of the linehaul (fuel must stay exact).
test('a split rate rounds the linehaul and keeps the fuel', () => {
  assert.equal(round(6308, 1200, 6500, 437), 6287)
})

// Kills: choosing the step from the total instead of the linehaul.
test('the split step is judged on the linehaul', () => {
  assert.equal(round(1087, 300, 2000, 100), 1075)
})

// Kills: removing the inward floor, or clamping to the upper bound itself.
test('a non-round upper bound pulls the rate inward to a multiple', () => {
  assert.equal(round(663, 133, 665), 650)
})

// Kills: removing the inward ceil, or clamping to the lower bound itself.
test('a non-round lower bound pulls the rate inward to a multiple', () => {
  assert.equal(round(1312, 1312, 6560), 1350)
})

// Kills: applying the bounds to the linehaul instead of the total.
test('split bounds apply to the total, so fuel shifts them', () => {
  assert.equal(round(665, 133, 665, 52), 652)
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
test('generated postings are round, in bounds, and keep the original fuel', () => {
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
    assert.equal(row.fuel_surcharge_usd, expectedFuel)
    const amount = row.rate_usd - row.fuel_surcharge_usd
    assert.equal(amount % stepFor(amount), 0, `${row.rate_usd} fuel ${row.fuel_surcharge_usd}`)
    assert.ok(row.rate_usd >= lower && row.rate_usd <= upper, `${row.rate_usd} in [${lower}, ${upper}]`)
  }
})

const counting = (next) => { const rng = () => { rng.calls += 1; return next() }; rng.calls = 0; return rng }
// Everything except rate_usd (fuel stays in): rounding must not disturb any other field.
const fingerprint = (rows) => createHash('sha256').update(JSON.stringify(rows.map(({ rate_usd, ...rest }) => rest))).digest('hex')

// Golden values were recorded at the commit BEFORE rounding existed, so they
// prove rounding adds no draw and shifts no other field. Time fields are
// integer minute offsets from now(), so the hash is deterministic.
// Kills: calling rng() inside roundPostedRate or at the call site (count and hash change).
test('rounding draws no random numbers', () => {
  const rng = counting(mulberry32(24))
  const rows = buildPostingRows({ rng, postingItems: makeItems(), drivers: [], trucks: [], fleetEquipment: [] })
  assert.equal(rng.calls, 500)
  assert.equal(fingerprint(rows), '9778b8d4902a694061a04dc0cc124e8db2e0dcbb6159cf98b763bae894d68ed0')

  const drivers = [{ id: 'a', current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' },
    { id: 'b', current_lat: 33.749, current_lon: -84.388, duty_status: 'on' }]
  const nearRng = counting(mulberry32(7))
  const near = buildNearCoverageRows({ rng: nearRng, drivers, brokerIds: new Map() })
  assert.equal(nearRng.calls, 140)
  assert.equal(near.length, 10)
  assert.equal(fingerprint(near), '000b12862b9a56965ca072524f7dedb4a6a676393d2aa5459a0332e4718c3f52')
})

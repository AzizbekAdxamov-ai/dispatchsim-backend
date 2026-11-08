// The search the query bar sends, and the SQL it becomes.
//
// The board is the one screen a dispatcher spends the day on, and its
// query is built from a dozen optional pieces. None of this needs a
// database: the statement is BUILT here and run elsewhere, so what is
// asserted is the text and the values that go with it -- which is where
// the two bugs this shape invites actually live. A mis-numbered
// placeholder ($5 against four values) and a filter that is silently
// dropped both produce a board that looks fine and is wrong.
//
// scripts/sql-check.js PREPAREs these same built statements against the
// real schema, so a renamed column or a broken CTE fails there. Between
// the two, the only thing left untested without a database is whether
// PostgreSQL agrees about the rows, and that is what the DB-gated tests
// are for.
//
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildListPostingsSql,
  buildCountPostingsSql,
} from '../src/modules/loadBoard/loadBoard.repository.js'
import { resolveDeadheadFrom } from '../src/modules/loadBoard/loadBoard.service.js'
import { listPostingsSchema } from '../src/modules/loadBoard/loadBoard.schemas.js'
import { CITIES } from '../scripts/seed/cities.js'

const BASE = { sort: 'posted', limit: 25, offset: 0 }
const DALLAS = CITIES.find((c) => c.city === 'Dallas' && c.state === 'TX')
const ATLANTA = CITIES.find((c) => c.city === 'Atlanta' && c.state === 'GA')

// Every $n in the text must have a value behind it, and every value must
// be referenced. This is the whole class of bug the old regex-renumbering
// build could produce, and it is silent: PostgreSQL answers "bind message
// supplies 4 parameters" only at runtime, on the one search that happens
// to use that combination of filters.
function assertPlaceholdersSound({ text, values }) {
  const used = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))
  for (const n of used) {
    assert.ok(n >= 1 && n <= values.length, `text uses $${n} but only ${values.length} values are bound`)
  }
  for (let n = 1; n <= values.length; n += 1) {
    assert.ok(used.has(n), `value ${n} (${String(values[n - 1])}) is bound but never used`)
  }
}

// Kills: any renumbering bug, including the one the old implementation
// invited -- a second fragment that needed parameters of its own.
test('every filter combination binds exactly the parameters it uses', () => {
  const combos = [
    {},
    { fromCity: 'Dallas', fromState: 'TX' },
    { toCity: 'Atlanta', toState: 'GA' },
    { fromCity: 'Dallas', fromState: 'TX', toCity: 'Atlanta', toState: 'GA' },
    { fromCity: 'Dallas', fromState: 'TX', toCity: 'Atlanta', toState: 'GA', maxDeadheadMi: 150, maxDeadheadDestMi: 150 },
    { equipmentType: ['reefer', 'dry-van'], originState: 'PA', destinationState: 'KY' },
    { originZone: 'northeast', destinationZone: 'midwest', minRatePerMile: 2.5 },
    { maxLengthFt: 48, maxWeightLbs: 34000 },
    { pickupFrom: new Date('2026-09-26T04:00:00Z'), pickupBefore: new Date('2026-09-27T04:00:00Z') },
  ]
  for (const combo of combos) {
    assertPlaceholdersSound(buildListPostingsSql({ ...BASE, ...combo }))
    assertPlaceholdersSound(buildCountPostingsSql({ ...BASE, ...combo }))
  }
})

// Kills: `p.equipment_type = $n` against the first element -- which would
// drop every other type the dispatcher asked for and show a board that
// looks like an answer.
test('several equipment types are one ANY(), not the first one', () => {
  const { text, values } = buildListPostingsSql({ ...BASE, equipmentType: ['reefer', 'dry-van'] })
  assert.match(text, /p\.equipment_type = ANY\(\$\d+\)/)
  assert.deepEqual(values[0], ['reefer', 'dry-van'])
})

// Kills: measuring the origin deadhead from the wrong point, including
// the lat/lon swap that a two-number call invites.
test('the origin point is the searched city, in that order', () => {
  const { text, values } = buildListPostingsSql({ ...BASE, fromCity: 'Dallas', fromState: 'TX' })
  assert.equal(values[0], DALLAS.lat)
  assert.equal(values[1], DALLAS.lon)
  assert.match(text, /road_miles\(\$1, \$2, p\.origin_lat, p\.origin_lon\)/)
})

// Kills: computing DH-D twice -- once for the column, once for the filter
// -- which is how the number on screen and the number being filtered on
// drift apart.
test('DH-D is computed once and used by both the column and the radius', () => {
  const { text, values } = buildListPostingsSql({
    ...BASE, toCity: 'Atlanta', toState: 'GA', maxDeadheadDestMi: 150,
  })
  const expr = /road_miles\(\$1, \$2, p\.destination_lat, p\.destination_lon\)::int/g
  assert.equal([...text.matchAll(expr)].length, 2, 'the same expression should appear in the SELECT and the WHERE')
  assert.match(text, /AS "deadheadDestMi"/)
  // The destination's coordinates are bound once, not twice.
  assert.equal(values.filter((v) => v === ATLANTA.lat).length, 1)
})

// Kills: applying the destination radius with no destination, which would
// compare against nothing and empty the board.
test('without a destination there is no DH-D and no destination radius', () => {
  const { text } = buildListPostingsSql({ ...BASE, maxDeadheadDestMi: 150 })
  assert.match(text, /NULL::int AS "deadheadDestMi"/)
  // p.destination_lat is a plain column in every row; what must be absent
  // is the distance computed against it.
  assert.doesNotMatch(text, /road_miles\([^)]*p\.destination_lat/)
})

// Kills: putting the radii in the count's WHERE, which makes "nearby"
// always zero -- the number exists precisely to say what lies outside.
test('the count applies the radii in the FILTER, not in the WHERE', () => {
  const { text } = buildCountPostingsSql({
    ...BASE, equipmentType: ['reefer'], maxDeadheadMi: 150,
  })
  const [beforeWhere, afterWhere] = text.split(/\bWHERE n\.id IS NOT NULL\b/)
  assert.match(beforeWhere, /count\(\*\) FILTER \(WHERE .*deadhead_mi/s)
  assert.doesNotMatch(afterWhere, /deadhead_mi/)
  assert.match(afterWhere, /p\.equipment_type = ANY/)
})

// Kills: dropping the FILTER's `true` default, which would make the
// statement invalid whenever no radius was given -- the ordinary search.
test('with no radius at all, matching and the wider count are the same query', () => {
  const { text } = buildCountPostingsSql({ ...BASE })
  assert.match(text, /count\(\*\) FILTER \(WHERE true\)::int AS "matching"/)
})

// Kills: `>=` where `<=` belongs. Length and weight are what the truck can
// take; inverted, the board offers exactly the loads that do not fit.
test('length and weight read as the truck maximum', () => {
  const { text, values } = buildListPostingsSql({ ...BASE, maxLengthFt: 48, maxWeightLbs: 34000 })
  assert.match(text, /p\.equipment_length_ft <= \$1/)
  assert.match(text, /p\.weight_lbs <= \$2/)
  assert.deepEqual(values.slice(0, 2), [48, 34000])
})

// Kills: an inclusive upper bound on the pickup window, which would pull
// in the first instant of the next day the picker is not showing.
test('the pickup window is inclusive at the bottom and exclusive at the top', () => {
  const from = new Date('2026-09-26T04:00:00Z')
  const before = new Date('2026-09-27T04:00:00Z')
  const { text, values } = buildListPostingsSql({ ...BASE, pickupFrom: from, pickupBefore: before })
  assert.match(text, /p\.pickup_at >= \$1/)
  assert.match(text, /p\.pickup_at < \$2/)
  assert.deepEqual(values.slice(0, 2), [from, before])
})

// Kills: sorting by the rate without the rate_hidden tiebreak. A "call
// for rate" posting that sorts by its hidden number lets the number be
// read off the row's position, which is the one thing that posting exists
// to prevent.
test('sorting by rate still puts hidden-rate postings last', () => {
  const { text } = buildListPostingsSql({ ...BASE, sort: 'rate' })
  assert.match(text, /ORDER BY p\.rate_hidden ASC, p\.rate_usd DESC/)
})

// Kills: accepting an unknown equipment key by dropping it. A filter that
// silently ignores half of what it was given shows a board nobody asked
// for.
test('the equipment list is parsed, and an unknown type is refused', () => {
  const parsed = listPostingsSchema.parse({ equipmentType: 'reefer, dry-van' })
  assert.deepEqual(parsed.equipmentType, ['reefer', 'dry-van'])
  assert.throws(() => listPostingsSchema.parse({ equipmentType: 'reefer,nope' }))
  assert.throws(() => listPostingsSchema.parse({ equipmentType: '' }))
})

// Kills: dropping the paired-field and ordering refinements, each of
// which turns a typo into a quietly different search.
test('half a destination, and a backwards window, are refused', () => {
  assert.throws(() => listPostingsSchema.parse({ toCity: 'Atlanta' }))
  assert.throws(() => listPostingsSchema.parse({ toState: 'GA' }))
  assert.doesNotThrow(() => listPostingsSchema.parse({ toCity: 'Atlanta', toState: 'GA' }))
  assert.throws(() => listPostingsSchema.parse({
    pickupFrom: '2026-09-28T00:00:00Z', pickupBefore: '2026-09-27T00:00:00Z',
  }))
})

// Kills: the `duty_status <> 'off'` filter coming back (a freshly seeded
// fleet is all 'off', so every posting would lose its DH-O and fall outside
// the radius), and an active-load rule of `<> 'done'` that counts cancelled
// and booked-not-dispatched loads as pinning a driver.
test('the fleet reference point accepts resting drivers and excludes only dispatched loads', () => {
  for (const build of [buildListPostingsSql, buildCountPostingsSql]) {
    const { text } = build({ ...BASE, maxDeadheadMi: 150 })
    assert.doesNotMatch(text, /duty_status/)
    assert.match(text, /l\.status IN \('ontime','warn','crit'\)/)
    assert.doesNotMatch(text, /l\.status <> 'done'/)
  }
})

// Kills: "outside the radius" being reported when there is nobody to
// measure deadhead from.
test('no origin, no driver and no posting driver reports kind none', () => {
  const none = resolveDeadheadFrom({ firstPosting: undefined, hasReference: false })
  assert.deepEqual(none, { kind: 'none' })
  assert.equal(resolveDeadheadFrom({ firstPosting: undefined, hasReference: true }), null)
  assert.equal(resolveDeadheadFrom({ fromCity: 'Dallas', fromState: 'TX', hasReference: false }).kind, 'location')
  assert.equal(
    resolveDeadheadFrom({ firstPosting: { nearestDriverId: 'd1', nearestDriverName: 'A' }, hasReference: false }).kind,
    'driver',
  )
})

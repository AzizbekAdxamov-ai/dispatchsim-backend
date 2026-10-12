// `npm run map:leftovers`: why each thing on the map is still there.
// Azizbek, 2026-10-08: test loads, his own live-test loads and old lanes
// were still drawn. Pure, plus one read of the script's own SQL. Each
// test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyLoad, isFixture, cancelIds, hoursSince } from '../scripts/mapLeftoversRules.js'
import { IN_TRANSIT_BOARD_SQL } from '../src/modules/tracking/tracking.repository.js'

const here = dirname(fileURLToPath(import.meta.url))
const NOW = new Date('2026-10-08T12:00:00Z')
const real = { broker: 'Redstone Logistics Partners', truckId: 'RS-9278-CY', driverEmail: 'grace@example.com' }

// Kills: a fixture marker missing -- each of the four the tests write.
test('every marker the test fixtures write is recognised, and a real row is not', () => {
  assert.equal(isFixture({ ...real, broker: 'Check Fixture Broker' }), true)
  assert.equal(isFixture({ ...real, broker: 'PTI Test Broker' }), true)
  assert.equal(isFixture({ ...real, truckId: 'FX-0412-TX' }), true)
  assert.equal(isFixture({ ...real, truckId: 'ZZ-0001-TX' }), true)
  assert.equal(isFixture({ ...real, driverEmail: 'd1412@fixture.test' }), true)
  assert.equal(isFixture(real), false)
})

// Kills: an open road event not ranked above an ETA (a stuck load would
// read "overdue -- start the backend", which would never fix it), or a
// fixture reported as a real stuck load.
test('fixture before stuck before overdue before running', () => {
  const past = '2026-10-07T12:00:00Z'
  const future = '2026-10-09T12:00:00Z'
  assert.equal(classifyLoad({ ...real, broker: 'UE Fixture Broker', openEventAt: past, etaAt: past }, NOW), 'fixture')
  assert.equal(classifyLoad({ ...real, openEventAt: past, etaAt: past }, NOW), 'stuck')
  assert.equal(classifyLoad({ ...real, openEventAt: null, etaAt: past }, NOW), 'overdue')
  assert.equal(classifyLoad({ ...real, openEventAt: null, etaAt: future }, NOW), 'running')
  assert.equal(hoursSince(past, NOW), 24)
})

// Kills: "--cancel all", junk ids, or a duplicate cancelled twice.
test('--cancel takes load ids only, each once', () => {
  assert.deepEqual(cancelIds(['node', 'x', '--cancel', '104882, 104883,104882']), ['104882', '104883'])
  assert.deepEqual(cancelIds(['node', 'x', '--cancel', 'all']), [])
  assert.deepEqual(cancelIds(['node', 'x']), [])
})

// Kills: the report and the map disagreeing about what is on the map --
// the report's WHERE must be the board's WHERE.
test('the report lists exactly what the tracking board draws', () => {
  const script = readFileSync(join(here, '..', 'scripts', 'map-leftovers.js'), 'utf8')
  const where = (sql) => sql.slice(sql.indexOf('WHERE l.delivered_at IS NULL'), sql.indexOf("('ontime', 'warn', 'crit')")).replace(/\s+/g, ' ')
  assert.ok(where(IN_TRANSIT_BOARD_SQL).length > 40)
  assert.equal(where(script), where(IN_TRANSIT_BOARD_SQL))
})

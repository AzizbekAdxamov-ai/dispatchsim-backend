import test from 'node:test'
import assert from 'node:assert/strict'
import { DEADHEAD_MAX_MI, MIN_NEAR_LOADS, TRAP_DH_PCT, nearLoadCoverage, buildNearCoverageRows } from '../scripts/seed/postings.js'
import { roadMiles } from '../scripts/seed/cities.js'
import { activeTruckLocations, withCoveredDestinations } from '../scripts/refresh-postings.js'
import { fleetCoverageHealthy, coverageOnlyRefresh } from '../src/jobs/dailyRefresh.js'
import { buildListPostingsSql } from '../src/modules/loadBoard/loadBoard.repository.js'
import { readFile } from 'node:fs/promises'

test('near-load coverage constants and guard are explicit', () => {
  assert.equal(DEADHEAD_MAX_MI, 150)
  assert.equal(MIN_NEAR_LOADS, 5)
  const rows = Array.from({ length: 5 }, () => ({ nearestDriverId: 'd1', deadheadMi: 150 }))
  assert.equal(nearLoadCoverage(rows), true)
  // Kills: changing <= 150 to < 150 would reject the boundary load.
  assert.equal(nearLoadCoverage([{ nearestDriverId: 'd1', deadheadMi: 151 }]), false)
})

test('truck locations and board query include parked trucks and visible 150-mile radius', async () => {
  // Kills: excluding driverless active trucks or dropping the board radius condition.
  const runner = { query: async () => ({ rows: [{ id: 't1', current_location: 'Chicago, IL', current_lat: null, current_lon: null }] }) }
  const [truck] = await activeTruckLocations(runner)
  assert.equal(truck.current_lat, 41.8781)
  const sql = buildListPostingsSql({ fromCity: 'Chicago', fromState: 'IL', maxDeadheadMi: 150, limit: 10, offset: 0 })
  assert.match(sql.text, /posted_at <= now\(\)/)
  assert.match(sql.text, /deadhead_mi <=/)
  assert.ok(sql.values.includes(150))
})

// Kills: passing a legacy display label or empty value to generateLoad as
// an equipment key; known canonical keys must survive without conversion.
test('active trucks retain valid equipment keys and treat unknown labels as unknown', async () => {
  const runner = { query: async () => ({ rows: [
    { id: 'a', trailer_type: 'reefer', current_lat: 1, current_lon: 2 },
    { id: 'b', trailer_type: 'Dry Van', current_lat: 1, current_lon: 2 },
    { id: 'c', trailer_type: '', current_lat: 1, current_lon: 2 },
  ] }) }
  const trucks = await activeTruckLocations(runner)
  assert.deepEqual(trucks.map((truck) => truck.trailer_type), ['reefer', null, null])
  const rows = buildNearCoverageRows({ rng: () => 0.5,
    drivers: [{ ...trucks[1], current_lat: 41.8781, current_lon: -87.6298 }], brokerIds: new Map() })
  assert.equal(rows.length, MIN_NEAR_LOADS)
})

test('coverage health becomes false after visible loads expire or are booked', async () => {
  // Kills: counting expired, future, booked, or fewer than five destination states.
  const calls = []
  const runner = { query: async (sql) => {
    calls.push(sql)
    return calls.length === 1 ? { rows: [{ id: 't1', current_lat: 41.8781, current_lon: -87.6298 }] } : { rows: [{ n: 4 }] }
  } }
  assert.equal(await fleetCoverageHealthy(runner), false)
  assert.match(calls[1], /status = 'open'.*posted_at <= now\(\).*expires_at > now\(\)/s)
})

// Kills: triggering a full daily market refresh for a nearby coverage gap.
test('a nearby gap uses the bounded posting refresh while a depleted market uses the daily refresh', () => {
  assert.equal(coverageOnlyRefresh(false, false), true)
  assert.equal(coverageOnlyRefresh(false, true), false)
  assert.equal(coverageOnlyRefresh(true, true), false)
})

test('generated coverage supplies five visible destinations at every active location', () => {
  // Kills: omitting either driver, emitting future postings, or reducing the minimum to four.
  const drivers = [{ id: 'a', current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' },
    { id: 'b', current_lat: 33.749, current_lon: -84.388, duty_status: 'on' }]
  const rows = buildNearCoverageRows({ rng: () => 0.5, drivers, brokerIds: new Map() })
  for (const driver of drivers) {
    const near = rows.filter((row) => roadMiles({ lat: driver.current_lat, lon: driver.current_lon }, { lat: row.origin_lat, lon: row.origin_lon }) <= DEADHEAD_MAX_MI)
    assert.ok(new Set(near.map((row) => row.destination_state)).size >= MIN_NEAR_LOADS)
    assert.ok(near.every((row) => /interval '-\d+ minutes'/.test(row.posted_at.value) && !/interval '-/.test(row.expires_at.value)))
  }
  assert.equal(TRAP_DH_PCT, 0.1)
})

// Kills: adding five new loads on every refresh even when visible loads
// already provide four distinct destinations, and counting expired loads.
test('nearby refresh fills only the missing destination coverage', async () => {
  const drivers = [{ id: 'a', current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' }]
  const calls = []
  const runner = { query: async (sql, values) => {
    calls.push({ sql, values })
    return { rows: ['CA', 'TX', 'FL', 'GA'].map((destination_state) => ({ destination_state })) }
  } }
  const covered = await withCoveredDestinations(drivers, runner)
  const rows = buildNearCoverageRows({ rng: () => 0.5, drivers: covered, brokerIds: new Map() })
  assert.equal(rows.length, 1)
  assert.ok(!covered[0].coveredDestinationStates.includes(rows[0].destination_state))
  assert.match(calls[0].sql, /status = 'open'.*posted_at <= now\(\).*expires_at > now\(\)/s)
  assert.equal(calls[0].values[2], DEADHEAD_MAX_MI)
})

// Kills: counting loads for a different trailer or generating duplicate
// coverage for two trucks in the same place with the same equipment.
test('coverage uses each truck trailer and shares matching nearby rows', async () => {
  const atChicago = { current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' }
  const drivers = [{ ...atChicago, id: 'a', trailer_type: 'dry-van' },
    { ...atChicago, id: 'b', trailer_type: 'dry-van' },
    { ...atChicago, id: 'c', trailer_type: 'reefer' }]
  const calls = []
  const runner = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] } } }
  const covered = await withCoveredDestinations(drivers, runner)
  assert.deepEqual(calls.map((call) => call.values[3]), ['dry-van', 'dry-van', 'reefer'])
  assert.match(calls[0].sql, /equipment_type = \$4/)
  const rows = buildNearCoverageRows({ rng: () => 0.5, drivers: covered, brokerIds: new Map() })
  assert.equal(rows.filter((row) => row.equipment_type === 'dry-van').length, MIN_NEAR_LOADS)
  assert.equal(rows.filter((row) => row.equipment_type === 'reefer').length, MIN_NEAR_LOADS)
})

test('coverage test kills a four-load minimum mutation', async () => {
  // Kills: changing the required minimum from five to four in the generator.
  const sourceUrl = new URL('../scripts/seed/postings.js', import.meta.url)
  const original = await readFile(sourceUrl, 'utf8')
  const mutant = original.replace('export const MIN_NEAR_LOADS = 5', 'export const MIN_NEAR_LOADS = 4')
    .replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, sourceUrl).href}'`)
  assert.notEqual(mutant, original)
  const { buildNearCoverageRows: generate } = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`)
  const rows = generate({ rng: () => 0.5, drivers: [{ id: 't1', current_lat: 41.8781, current_lon: -87.6298, duty_status: 'on' }], brokerIds: new Map() })
  assert.throws(() => assert.ok(rows.length >= MIN_NEAR_LOADS))
})

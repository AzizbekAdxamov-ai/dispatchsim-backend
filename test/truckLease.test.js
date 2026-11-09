// Weekly truck lease (2026-11-10): charged only while a driver is assigned,
// on the operational sim clock, capped like interest and insurance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TRUCK_LEASE_WEEKLY_USD, SIM_DAYS_PER_WEEK, leaseAccrual, weeklyLeaseFor } from '../src/constants/truckLease.js'
import { REAL_MS_PER_SIM_DAY, FINANCE_REAL_MS_PER_SIM_DAY, MAX_CATCHUP_REAL_MS } from '../src/constants/simClock.js'
import { billTruck, chargeTruckLeases, LEASED_RUNNING_SQL } from '../src/modules/fleet/truckLease.service.js'
import { unassignDriver, assignDriver } from '../src/modules/fleet/truckListings.repository.js'
import { unassignDriver as unassignService } from '../src/modules/fleet/truckListings.service.js'
import { truckOptionsFromRows } from '../src/modules/drivers/drivers.service.js'
import { TRUCK_LEASE_ROWS_SQL } from '../src/modules/finance/finance.repository.js'

const read = (file) => readFileSync(join(process.cwd(), file), 'utf8')
const T0 = new Date('2026-11-10T12:00:00Z')
const after = (ms) => new Date(T0.getTime() + ms)
const DRY_VAN_DAY = TRUCK_LEASE_WEEKLY_USD['dry-van'] / SIM_DAYS_PER_WEEK // 150
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000
const TWO_MIN_MS = 2 * 60 * 1000
// One tick bills at most MAX_CATCHUP_REAL_MS (5 real minutes = 1/6 of a sim day).
const TICK_MS = MAX_CATCHUP_REAL_MS
const TICK_USD = DRY_VAN_DAY * (MAX_CATCHUP_REAL_MS / REAL_MS_PER_SIM_DAY)

function fakeClient({ rows = [], loads = [], truck = null } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return { rows }
      if (sql.includes('FROM trucks WHERE driver_id')) return { rows: truck ? [truck] : [] }
      if (sql.includes('FROM loads')) return { rows: loads }
      if (sql.includes('INSERT INTO cash_ledger')) return { rows: [{ id: 1 }] }
      if (sql.includes('sum(amount_usd)')) return { rows: [{ balance: 1000 }] }
      return { rows: [] }
    },
  }
}
const ledger = (c) => c.calls.filter((x) => x.sql.includes('INSERT INTO cash_ledger'))
const updates = (c) => c.calls.filter((x) => x.sql.startsWith('UPDATE trucks'))
const row = (over = {}) => ({ id: 'TX-5101-DV', trailer_type: 'dry-van', lease_billed_through: T0, lease_accrued_usd: '0', ...over })

// Kills: the finance clock (2 min/day) used for rent, which would bill 10 trucks hundreds of dollars a real minute
test('a dry van costs $150 per operational sim day (30 real minutes), not per finance day (2 minutes)', () => {
  assert.equal(TICK_USD, 25)
  assert.equal(leaseAccrual({ weeklyUsd: 1050, elapsedMs: TWO_MIN_MS }), DRY_VAN_DAY * (TWO_MIN_MS / REAL_MS_PER_SIM_DAY))
  assert.ok(leaseAccrual({ weeklyUsd: 1050, elapsedMs: FINANCE_REAL_MS_PER_SIM_DAY }) < DRY_VAN_DAY / 10)
  let accrued = 0
  for (let tick = 0; tick < REAL_MS_PER_SIM_DAY / TICK_MS; tick += 1) accrued = leaseAccrual({ weeklyUsd: 1050, elapsedMs: TICK_MS, accruedUsd: accrued })
  assert.equal(accrued, DRY_VAN_DAY)
})

// Kills: a closed laptop (8 real hours) billed as 16 sim days of rent
test('a long gap is capped like interest and insurance', () => {
  assert.equal(leaseAccrual({ weeklyUsd: 1050, elapsedMs: EIGHT_HOURS_MS }), leaseAccrual({ weeklyUsd: 1050, elapsedMs: MAX_CATCHUP_REAL_MS }))
  assert.equal(leaseAccrual({ weeklyUsd: 1050, elapsedMs: EIGHT_HOURS_MS }), TICK_USD)
})

// Kills: rent per truck type not following the type table
test('rent follows the equipment key; an unknown key has none', () => {
  assert.equal(weeklyLeaseFor('flatbed'), 1150)
  assert.equal(weeklyLeaseFor('reefer'), 1400)
  assert.equal(weeklyLeaseFor('tanker'), null)
})

// Kills: a lease written before a sim day of rent built up, or losing the remainder
test('under a sim day nothing is written and the accrual is carried; the watermark moves', async () => {
  const c = fakeClient()
  const result = await billTruck(c, row(), after(TICK_MS))
  assert.equal(result, null)
  assert.equal(ledger(c).length, 0)
  assert.equal(updates(c).length, 1)
  assert.equal(updates(c)[0].params[2], TICK_USD)
})

// Kills: wrong ledger kind/ref/sign, or a remainder dropped after a charge
test('a sim day writes a truck_lease entry for the truck and keeps the cents', async () => {
  const c = fakeClient()
  const result = await billTruck(c, row({ lease_accrued_usd: String(DRY_VAN_DAY - TICK_USD + 0.5) }), after(TICK_MS))
  assert.deepEqual(result, { truckId: 'TX-5101-DV', amountUsd: DRY_VAN_DAY })
  const [entry] = ledger(c)
  assert.deepEqual(entry.params.slice(0, 5), ['truck_lease', -DRY_VAN_DAY, 'Truck lease — TX-5101-DV', 'truck', 'TX-5101-DV'])
  assert.equal(updates(c)[0].params[2], 0.5)
})

// Kills: lease running on trucks without a driver, without the lease flag, or without a watermark
test('the tick reads only leased trucks with a driver and a running watermark', () => {
  assert.match(LEASED_RUNNING_SQL, /WHERE is_leased AND driver_id IS NOT NULL AND lease_billed_through IS NOT NULL/)
  assert.match(LEASED_RUNNING_SQL, /FOR UPDATE SKIP LOCKED/)
})

// Kills: an empty fleet or no billable truck writing a charge
test('no running trucks writes nothing; two trucks write two entries', async () => {
  const empty = fakeClient()
  assert.equal(await chargeTruckLeases({ enabled: true, run: (fn) => fn(empty), nowFn: () => T0 }), null)
  assert.equal(ledger(empty).length, 0)
  const nearlyDue = String(DRY_VAN_DAY - TICK_USD)
  const two = fakeClient({ rows: [row({ lease_accrued_usd: nearlyDue }), row({ id: 'GA-5102-DV', lease_accrued_usd: nearlyDue })] })
  const charged = await chargeTruckLeases({ enabled: true, run: (fn) => fn(two), nowFn: () => after(TICK_MS) })
  assert.equal(ledger(two).length, 2)
  assert.equal(charged.amountUsd, 2 * DRY_VAN_DAY)
  assert.equal(charged.trucks, 2)
})

// Kills: FINANCE=off still touching the ledger or the database
test('FINANCE off: nothing queried, nothing charged', async () => {
  const c = fakeClient({ rows: [row()] })
  assert.equal(await chargeTruckLeases({ enabled: false, run: (fn) => fn(c), nowFn: () => after(TICK_MS) }), null)
  assert.equal(c.calls.length, 0)
})

// Kills: unassign dropping the rent earned since the last tick, or leaving the watermark so rent continues
test('unassign pays the rent up to now, then clears the watermark', async () => {
  const c = fakeClient({ truck: { ...row(), is_leased: true } })
  const result = await unassignDriver(c, { driverId: 'd1', billLease: (client, t) => billTruck(client, t, after(TICK_MS), { flush: true }) })
  assert.equal(result.ok, true)
  assert.equal(ledger(c).length, 1)
  const release = updates(c).at(-1)
  assert.match(release.sql, /driver_id = NULL, lease_billed_through = NULL, lease_accrued_usd = 0/)
})

// Kills: flush skipped (a few hours of rent lost)
test('flush writes a charge before a full sim day has built up', async () => {
  const c = fakeClient()
  const result = await billTruck(c, row(), after(TWO_MIN_MS), { flush: true })
  assert.equal(result.amountUsd, Math.floor(DRY_VAN_DAY * (TWO_MIN_MS / REAL_MS_PER_SIM_DAY)))
  assert.equal(await billTruck(fakeClient(), row(), after(TWO_MIN_MS)), null)
})

// Kills: unassigning a truck that is on a load
test('an active load refuses the unassign and changes nothing', async () => {
  const c = fakeClient({ truck: { ...row(), is_leased: true }, loads: [{ one: 1 }] })
  let billed = false
  const result = await unassignDriver(c, { driverId: 'd1', billLease: async () => { billed = true } })
  assert.equal(result.error, 'TRUCK_HAS_ACTIVE_LOAD')
  const check = c.calls.find((x) => x.sql.includes('FROM loads')).sql
  assert.match(check, /\(driver_id = \$1 OR truck_id = \$2\) AND status NOT IN \('done', 'cancelled', 'neutral'\)/)
  assert.equal(billed, false)
  assert.equal(updates(c).length, 0)
  assert.equal(ledger(c).length, 0)
})

// Kills: unassign for a driver without a truck succeeding silently
test('a driver with no truck gets DRIVER_HAS_NO_TRUCK', async () => {
  const result = await unassignDriver(fakeClient(), { driverId: 'd1' })
  assert.equal(result.error, 'DRIVER_HAS_NO_TRUCK')
  await assert.rejects(unassignService({ driverId: 'd1' }, { enabled: true, run: (fn) => fn(fakeClient()) }), (err) => err.code === 'DRIVER_HAS_NO_TRUCK')
})

// Kills: assign leaving the truck where it was parked, or not starting the rent
test('assign moves the truck to the driver and starts the lease watermark only for leased trucks', async () => {
  const c = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params })
      if (sql.includes('FROM trucks WHERE id')) return { rows: [{ id: 'T1', status: 'idle', driver_id: null, is_leased: true }] }
      return { rows: [] }
    },
  }
  assert.deepEqual(await assignDriver(c, { truckId: 'T1', driverId: 'd1' }), { ok: true })
  const update = c.calls.find((x) => x.sql.startsWith('UPDATE trucks'))
  assert.match(update.sql, /current_location = COALESCE\(NULLIF\(btrim\(d\.current_location\), ''\)/)
  assert.match(update.sql, /location_city = COALESCE\(d\.current_city, t\.location_city\)/)
  assert.match(update.sql, /lease_billed_through = CASE WHEN t\.is_leased THEN now\(\) END/)
  assert.match(update.sql, /lease_accrued_usd = 0/)
})

// Kills: the options page hiding what the truck pulls or what it costs
test('truck options carry the equipment key, length and weekly lease of a leased truck only', () => {
  const [leased, owned] = truckOptionsFromRows([
    { id: 'A', status: 'idle', equipmentType: 'reefer', trailerLengthFt: 53, isLeased: true },
    { id: 'B', status: 'idle', equipmentType: 'dry-van', trailerLengthFt: 53, isLeased: false },
  ])
  assert.deepEqual([leased.equipmentType, leased.trailerLengthFt, leased.leaseWeeklyUsd], ['reefer', 53, TRUCK_LEASE_WEEKLY_USD.reefer])
  assert.equal(owned.leaseWeeklyUsd, null)
})

// Kills: lease missing from the ledger kinds or the database guards
test('075 keeps every 032 ledger kind, adds truck_lease and the lease guards', () => {
  const sql = read('src/db/migrations/075_truck_lease.sql')
  const kindList = /ADD CONSTRAINT ledger_kind CHECK \(kind IN \(([\s\S]*?)\)\);/
  const kinds = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.deepEqual(kinds(sql.match(kindList)[1]), [...kinds(read('src/db/migrations/032_truck_wear.sql').match(kindList)[1]), 'truck_lease'])
  assert.match(sql, /is_leased boolean NOT NULL DEFAULT false/)
  assert.match(sql, /CHECK \(lease_billed_through IS NULL OR \(is_leased AND driver_id IS NOT NULL\)\)/)
  assert.match(sql, /CHECK \(lease_accrued_usd >= 0\)/)
})

// Kills: the lease missing from the tick, the expenses, the overview or the route
test('the tick, expenses, overview and route carry the lease', () => {
  assert.match(read('src/modules/loads/dispatch.service.js'), /settle\('lease', chargeTruckLeases\)/)
  assert.match(read('src/jobs/opsTick.js'), /lease\?\.amountUsd/)
  assert.match(TRUCK_LEASE_ROWS_SQL, /kind = 'truck_lease'/)
  const finance = read('src/modules/finance/finance.service.js')
  assert.match(finance, /category: 'truck_lease'/)
  assert.match(finance, /truckLease,/)
  assert.match(read('src/modules/drivers/drivers.routes.js'), /router\.delete\('\/:id\/truck', requireRole\('dispatcher', 'fleet-manager'\)/)
})

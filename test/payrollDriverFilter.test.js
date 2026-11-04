// Payroll for one driver must not pay anybody else.
//
// POST /payroll/run used to pay every overdue settlement; paying one driver
// (Ethan, $256) paid the whole company. These tests need no database: the
// service takes its transaction runner and repos as a seam.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runPayroll } from '../src/modules/payroll/payroll.service.js'
import { claimDueSettlements } from '../src/modules/payroll/payroll.repository.js'
import { CLAIM_DUE_SETTLEMENTS_SQL } from '../src/modules/payroll/payroll.sql.js'
import { driverIdFromBody } from '../src/modules/payroll/payroll.controller.js'

const ONE_SETTLEMENT = { id: 's1', driverId: 'd11', loadId: 'L1', netUsd: 256, dueAt: 'x', driverName: 'Ethan' }

function fakes() {
  const claimed = []
  let served = false
  return {
    claimed,
    deps: {
      run: async (fn) => fn({}),
      payrollRepo: {
        claimDueSettlements: async (_c, limit, driverId) => {
          claimed.push({ limit, driverId })
          if (served) return []
          served = true
          return [ONE_SETTLEMENT]
        },
        markPaid: async (_c, id) => ({ id, driverId: 'd11', loadId: 'L1', netUsd: 256 }),
        driverOwedAll: async () => [],
      },
      cash: { addEntry: async () => {}, getBalance: async () => 0 },
    },
  }
}

// Kills: payroll run for one driver also paying another (Ethan $256, 2026-11-05)
test('runPayroll hands the driver filter to every claim', async () => {
  const { claimed, deps } = fakes()
  await runPayroll({ userId: 'u1', driverId: 'd11' }, deps)
  assert.ok(claimed.length >= 1)
  for (const c of claimed) assert.equal(c.driverId, 'd11')
})

// Kills: a missing driverId filtering everyone out (payroll for all paying nobody)
test('runPayroll without a driver keeps the old behaviour (null filter)', async () => {
  const { claimed, deps } = fakes()
  await runPayroll({ userId: 'u1' }, deps)
  for (const c of claimed) assert.equal(c.driverId, null)
})

// Kills: payroll run for one driver also paying another (Ethan $256, 2026-11-05)
test('the claim query is filtered by driver and the repo passes it as $2', async () => {
  assert.match(CLAIM_DUE_SETTLEMENTS_SQL, /\$2::text IS NULL OR s\.driver_id = \$2/)
  let params
  await claimDueSettlements({ query: async (_sql, p) => { params = p; return { rows: [] } } }, 1, 'd11')
  assert.deepEqual(params, [1, 'd11'])
  await claimDueSettlements({ query: async (_sql, p) => { params = p; return { rows: [] } } })
  assert.deepEqual(params, [25, null])
})

// Kills: a blank or non-string driverId reaching SQL as a filter (Ethan $256 run, 2026-11-05)
test('driverIdFromBody: absent means everyone, junk is rejected', () => {
  assert.equal(driverIdFromBody(undefined), null)
  assert.equal(driverIdFromBody({}), null)
  assert.equal(driverIdFromBody({ driverId: null }), null)
  assert.equal(driverIdFromBody({ driverId: ' d11 ' }), 'd11')
  for (const bad of ['', '  ', 5, {}, []]) {
    assert.throws(() => driverIdFromBody({ driverId: bad }), { code: 'VALIDATION_ERROR' })
  }
})

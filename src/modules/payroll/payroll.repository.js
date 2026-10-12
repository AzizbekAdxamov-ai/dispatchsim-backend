// Data access for driver_settlements. The SQL lives in payroll.sql.js so
// scripts/sql-check.js can parse every statement against the real schema.

import { query } from '../../db/pool.js'
import * as SQL from './payroll.sql.js'

// Earn a settlement. Returns null when one already exists for this load --
// not an error: the tick retries, and a retry finding the work already
// done is the normal case, not a failure.
export async function createSettlement(client, {
  driverId, loadId, grossUsd, deductionsUsd, netUsd, dueSeconds,
}) {
  const result = await client.query(SQL.CREATE_SETTLEMENT_SQL, [
    driverId, loadId, grossUsd, deductionsUsd, netUsd, dueSeconds,
  ])
  return result.rows[0] ?? null
}

export async function claimDueSettlements(client, limit = 25) {
  const result = await client.query(SQL.CLAIM_DUE_SETTLEMENTS_SQL, [limit])
  return result.rows
}

// Zero rows means somebody else paid it between the claim and here, and no
// money should move.
export async function markPaid(client, id) {
  const result = await client.query(SQL.MARK_SETTLEMENT_PAID_SQL, [id])
  return result.rows[0] ?? null
}

export async function listSettlements() {
  const result = await query(SQL.LIST_SETTLEMENTS_SQL)
  return result.rows
}

export async function driverOwedAll() {
  const result = await query(SQL.DRIVER_OWED_SQL)
  return result.rows
}

// Asked at the moment of dispatch, so it takes a client: the answer has to
// come from inside the same transaction that is about to assign the load.
export async function driverOwed(client, driverId) {
  const runner = client ?? { query }
  const result = await runner.query(SQL.DRIVER_OWED_ONE_SQL, [driverId])
  return result.rows[0] ?? null
}

// Lock the tick watermark and return it; null when this is the first tick
// ever seen (the row is created at `now` and there is no gap to measure).
export async function lockTickClock(client, now) {
  await client.query(SQL.ENSURE_TICK_CLOCK_SQL, [now.toISOString()])
  const result = await client.query(SQL.READ_TICK_CLOCK_SQL)
  const raw = result.rows[0]?.lastAt
  return raw ? new Date(raw) : null
}

export async function writeTickClock(client, at) {
  await client.query(SQL.WRITE_TICK_CLOCK_SQL, [at.toISOString()])
}

// Returns how many unpaid settlements were pushed.
export async function holdSettlementClock(client, seconds) {
  const result = await client.query(SQL.HOLD_SETTLEMENT_CLOCK_SQL, [seconds])
  return result.rowCount
}

// Charges the weekly lease of company trucks that have a driver. The tick
// calls chargeTruckLeases; unassigning a truck calls billTruck with flush so
// the rent up to that moment is paid before it stops.
import config from '../../config.js'
import { withTransaction } from '../../db/pool.js'
import * as cashRepo from '../cash/cash.repository.js'
import {
  TRUCK_LEASE_LEDGER_KIND, TRUCK_LEASE_REF_TYPE, LEASE_POST_MIN_SIM_DAYS, SIM_DAYS_PER_WEEK,
  weeklyLeaseFor, leaseAccrual,
} from '../../constants/truckLease.js'

// truck: { id, trailer_type, lease_billed_through, lease_accrued_usd } (locked row).
// Returns the charge written, or null. Always moves the watermark.
export async function billTruck(client, truck, now, { flush = false } = {}) {
  const weeklyUsd = weeklyLeaseFor(truck.trailer_type)
  if (weeklyUsd === null || !truck.lease_billed_through) return null
  const accrued = leaseAccrual({
    weeklyUsd, elapsedMs: now.getTime() - new Date(truck.lease_billed_through).getTime(),
    accruedUsd: Number(truck.lease_accrued_usd) || 0,
  })
  const whole = Math.floor(accrued)
  const due = flush || accrued >= (weeklyUsd / SIM_DAYS_PER_WEEK) * LEASE_POST_MIN_SIM_DAYS
  const posted = due && whole >= 1
  if (posted) {
    await cashRepo.addEntry(client, {
      kind: TRUCK_LEASE_LEDGER_KIND,
      amountUsd: -whole,
      description: `Truck lease — ${truck.id}`,
      refType: TRUCK_LEASE_REF_TYPE,
      refId: truck.id,
    })
  }
  const carried = posted ? accrued - whole : accrued
  await client.query(
    'UPDATE trucks SET lease_billed_through = $2, lease_accrued_usd = $3 WHERE id = $1',
    [truck.id, now, Number(carried.toFixed(6))],
  )
  return posted ? { truckId: truck.id, amountUsd: whole } : null
}

export const LEASED_RUNNING_SQL = `
  SELECT id, trailer_type, lease_billed_through, lease_accrued_usd
    FROM trucks
   WHERE is_leased AND driver_id IS NOT NULL AND lease_billed_through IS NOT NULL
   ORDER BY id
     FOR UPDATE SKIP LOCKED`

// Same two seams as chargeInsurance. FINANCE=off: nothing accrues, watermarks stand.
export async function chargeTruckLeases({ enabled = config.financeEnabled, run = withTransaction, nowFn = () => new Date() } = {}) {
  if (!enabled) return null
  let charged = null
  await run(async (client) => {
    const now = nowFn()
    const trucks = (await client.query(LEASED_RUNNING_SQL)).rows
    const lines = []
    for (const truck of trucks) {
      const line = await billTruck(client, truck, now)
      if (line) lines.push(line)
    }
    if (lines.length > 0) {
      charged = {
        amountUsd: lines.reduce((sum, l) => sum + l.amountUsd, 0),
        trucks: lines.length,
        lines,
        balance: await cashRepo.getBalance(client),
      }
    }
  })
  return charged
}

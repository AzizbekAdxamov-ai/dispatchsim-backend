// Weekly lease for a company truck (tractor and trailer together), charged
// only while a driver is assigned to it. A truck standing unassigned costs
// nothing: it is "available to lease". Azizbek, 2026-11-10.
//
// Billed on the OPERATIONAL sim clock (billableSimDays: 1 day = 30 real
// minutes, a week = 3.5 real hours), not the 2-minute finance clock, which
// would put ten trucks at hundreds of dollars a real minute. The same
// billing cap applies, so a laptop closed for 8 hours is not 240 days of rent.
import { billableSimDays } from './simClock.js'

// Keyed by equipmentType key (data/equipmentTypes.js), never by label.
export const TRUCK_LEASE_WEEKLY_USD = Object.freeze({ 'dry-van': 1050, flatbed: 1150, reefer: 1400 })
export const SIM_DAYS_PER_WEEK = 7
// A charge is written once at least this many sim days of rent have built up,
// so the ledger gets a few rows a week, not one per tick.
export const LEASE_POST_MIN_SIM_DAYS = 1
export const TRUCK_LEASE_LEDGER_KIND = 'truck_lease'
export const TRUCK_LEASE_REF_TYPE = 'truck'

export const weeklyLeaseFor = (equipmentType) => TRUCK_LEASE_WEEKLY_USD[equipmentType] ?? null

// Pure: rent owed after elapsedMs more of lease, on top of what was carried over.
export function leaseAccrual({ weeklyUsd, elapsedMs, accruedUsd = 0 }) {
  return accruedUsd + billableSimDays(elapsedMs) * (weeklyUsd / SIM_DAYS_PER_WEEK)
}

// Business logic for the /fleet/* endpoints. Combines
// trucks.repository.js, maintenance.repository.js and metrics.repository.js
// — no SQL lives here, only shaping and the delta/cost-breakdown math.

import * as trucksRepo from './trucks.repository.js'
import * as maintenanceRepo from './maintenance.repository.js'
import * as metricsRepo from './metrics.repository.js'
import { AppError } from '../../lib/errors.js'
import { withDelta } from '../../lib/delta.js'
import { FUEL_PRICE_PER_GAL, FIXED_COST_PER_MILE } from '../finance/finance.constants.js'
import { withTransaction } from '../../db/pool.js'
import * as cash from '../cash/cash.service.js'
import { OIL_SERVICE_COST_USD } from '../../constants/truckWear.js'

// Fill the tank toward `toPct` and bill ONLY what went in.
//
// Diesel bought at the pump is the money event, and it is the mirror of
// delivery: there the ledger paid for the burn the tank did not cover, here
// the ledger pays for the gallons the pump adds. One dollar, one place.
//
// Nothing is charged when the tank is already at or past the requested
// level: returning a row saying "gallonsAdded: 0, charged $0" states the
// fact without inventing a sale.
export async function refuel({ truckId, toPct, userId }) {
  return withTransaction(async (client) => {
    const truck = await trucksRepo.lockTruckForRun(client, truckId)
    if (!truck) throw new AppError('TRUCK_NOT_FOUND')

    const toGallons = Math.round((truck.fuelCapacityGal * toPct) / 100)
    const updated = await trucksRepo.refuelTruck(client, { truckId, toGallons })
    if (!updated) throw new AppError('TRUCK_NOT_FOUND')

    // fromTank was read under the same lock the UPDATE ran under, so
    // gallonsAdded cannot race with a concurrent delivery's burn.
    const gallonsAdded = Math.max(0, updated.gallonsAfter - truck.fuelGallons)
    let chargedUsd = 0
    if (gallonsAdded > 0) {
      chargedUsd = Math.round(gallonsAdded * FUEL_PRICE_PER_GAL)
      await cash.spend(client, {
        kind: 'fuel',
        amountUsd: chargedUsd,
        description: `Fuel — ${gallonsAdded} gal into ${truckId}`,
        refType: 'truck',
        refId: truckId,
        userId,
      })
    }

    return {
      truckId,
      fuelPct: toPct,
      gallonsAdded,
      chargedUsd,
    }
  })
}

// Complete an open service record: the work is done, the money leaves.
// Refuses silently-done work with SERVICE_ALREADY_DONE rather than
// returning quietly -- a row that reports success for work that was already
// billed teaches the student that the second click was free.
export async function performService({ recordId, userId }) {
  return withTransaction(async (client) => {
    const record = await maintenanceRepo.completeService(client, {
      recordId,
      costUsd: OIL_SERVICE_COST_USD,
    })
    if (!record) {
      // Distinguish "never existed" from "already done" -- a 404 and a 409
      // are different facts about what the caller just did.
      const exists = await maintenanceRepo.getById(recordId)
      if (!exists) throw new AppError('SERVICE_NOT_FOUND')
      throw new AppError('SERVICE_ALREADY_DONE')
    }

    await cash.spend(client, {
      kind: 'maintenance',
      amountUsd: OIL_SERVICE_COST_USD,
      description: `${record.service} — ${record.truckId}`,
      refType: 'maintenance_record',
      refId: String(record.id),
      userId,
    })
    return { id: record.id, truckId: record.truckId, service: record.service, costUsd: OIL_SERVICE_COST_USD }
  })
}

export async function listTrucks({ limit }) {
  const [trucks, summary] = await Promise.all([
    trucksRepo.listTrucks({ limit }),
    trucksRepo.getTruckSummary(),
  ])
  const { avgFuelPct, ...counts } = summary
  return { trucks, meta: { counts, avgFuelPct } }
}

// Splits a truck's trailing-7-day cost into fuel / maintenance / other
// shares. `other` is everything the fixed-cost-per-mile constant covers
// (insurance, tolls, admin, factoring — see finance.constants.js) allocated
// across the same week's distance, so a parked truck naturally shows
// almost no "other" cost either. Labels are keys, not display text — see
// lib/loadTimeline.js's comment on the same "no hardcoded UI copy" rule;
// TruckDetail.jsx maps `label` to a color itself (CLAUDE.md: no hardcoded
// color on the backend, either).
function buildCostBreakdown({ weeklyFuelGallons, weeklyDistanceMi, weeklyMaintenanceUsd }) {
  const fuelUsd = weeklyFuelGallons * FUEL_PRICE_PER_GAL
  const otherUsd = weeklyDistanceMi * FIXED_COST_PER_MILE
  const totalUsd = fuelUsd + weeklyMaintenanceUsd + otherUsd

  if (totalUsd <= 0) {
    return [
      { label: 'fuel', pct: 0 },
      { label: 'maintenance', pct: 0 },
      { label: 'other', pct: 0 },
    ]
  }

  return [
    { label: 'fuel', pct: Math.round((fuelUsd / totalUsd) * 100) },
    { label: 'maintenance', pct: Math.round((weeklyMaintenanceUsd / totalUsd) * 100) },
    { label: 'other', pct: Math.round((otherUsd / totalUsd) * 100) },
  ]
}

export async function getTruckById(id) {
  const truck = await trucksRepo.getTruckById(id)
  if (!truck) {
    throw new AppError('TRUCK_NOT_FOUND')
  }

  const [window, weeklyCost, fuelTrend, distanceTrend] = await Promise.all([
    metricsRepo.getWeeklyWindow(id),
    maintenanceRepo.getWeeklyCostByTruckId(id),
    metricsRepo.getFuelTrend(id),
    metricsRepo.getDistanceTrend(id),
  ])

  const currentMpg = window.currentFuelGallons > 0 ? window.currentDistanceMi / window.currentFuelGallons : 0
  const previousMpg = window.previousFuelGallons > 0 ? window.previousDistanceMi / window.previousFuelGallons : 0

  const metrics = {
    weeklyDistance: withDelta(window.currentDistanceMi, window.previousDistanceMi),
    mpg: withDelta(Math.round(currentMpg * 10) / 10, Math.round(previousMpg * 10) / 10),
    idleHours: withDelta(
      Math.round((window.currentIdleMinutes / 60) * 10) / 10,
      Math.round((window.previousIdleMinutes / 60) * 10) / 10,
    ),
    maintenanceCost: withDelta(weeklyCost.currentUsd, weeklyCost.previousUsd),
  }

  const costBreakdown = buildCostBreakdown({
    weeklyFuelGallons: window.currentFuelGallons,
    weeklyDistanceMi: window.currentDistanceMi,
    weeklyMaintenanceUsd: weeklyCost.currentUsd,
  })

  return { ...truck, metrics, costBreakdown, fuelTrend, distanceTrend }
}

export async function listMaintenance({ limit }) {
  const [records, summary] = await Promise.all([
    maintenanceRepo.listMaintenance({ limit }),
    maintenanceRepo.getMaintenanceSummary(),
  ])
  const { monthCostUsd, ...counts } = summary
  return { records, meta: { counts, monthCostUsd } }
}


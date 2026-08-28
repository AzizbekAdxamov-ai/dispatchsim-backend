// Business logic for the drivers read endpoints. Combines
// drivers.repository.js (the driver row + its embedded truck/currentLoad)
// with loads.repository.js (recentLoads[], a real multi-row loads listing —
// see the ownership note at the top of drivers.repository.js) and the
// shared progress math so a driver's currentLoad carries the same
// `progress` a load detail page would compute. No SQL lives here.

import * as driversRepo from './drivers.repository.js'
import * as loadsRepo from '../loads/loads.repository.js'
import { AppError } from '../../lib/errors.js'
import { computeProgress } from '../../lib/loadTimeline.js'

function withCurrentLoadProgress(driver) {
  if (!driver.currentLoad) return driver
  return {
    ...driver,
    currentLoad: { ...driver.currentLoad, progress: computeProgress(driver.currentLoad) },
  }
}

export async function listDrivers({ limit }) {
  const [rows, counts] = await Promise.all([
    driversRepo.listDrivers({ limit }),
    driversRepo.countDriverStatuses(),
  ])

  return { drivers: rows.map(withCurrentLoadProgress), meta: { counts } }
}

export async function getDriverById(id) {
  const driver = await driversRepo.getDriverById(id)
  if (!driver) {
    throw new AppError('DRIVER_NOT_FOUND')
  }

  const recentLoads = await loadsRepo.listLoadsByDriverId(id, { limit: 10 })

  return { ...withCurrentLoadProgress(driver), recentLoads }
}

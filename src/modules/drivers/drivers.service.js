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
import { fuelPercent } from '../driverChat/driverChat.prompt.js'
import config from '../../config.js'

function withCurrentLoadProgress(driver) {
  if (!driver.currentLoad) return driver
  return {
    ...driver,
    currentLoad: { ...driver.currentLoad, progress: computeProgress(driver.currentLoad) },
  }
}

// Whether this driver is the one the Telegram bot answers as. The bot is
// configured by NAME (TELEGRAM_DRIVER_NAME), so the flag is a name
// comparison -- and nothing else: the token, the chat id and every other
// bot secret stay in config, and none of them reach this response.
function withTelegramFlag(driver) {
  const botName = config.telegramDriverName
  return {
    ...driver,
    telegram: botName != null
      && driver.name.trim().toLowerCase() === botName.trim().toLowerCase(),
  }
}

// The truck's tank through the ONE percent calculation the driver chat
// already uses, so the profile page and the driver's own words about
// their fuel can never disagree about the same tank.
function withTruckFuelPercent(driver) {
  if (!driver.truck) return driver
  return { ...driver, truck: { ...driver.truck, fuelPercent: fuelPercent(driver.truck) } }
}

export async function listDrivers({ limit }) {
  const [rows, counts] = await Promise.all([
    driversRepo.listDrivers({ limit }),
    driversRepo.countDriverStatuses(),
  ])

  return { drivers: rows.map((d) => withTelegramFlag(withCurrentLoadProgress(d))), meta: { counts } }
}

export async function getDriverById(id) {
  const driver = await driversRepo.getDriverById(id)
  if (!driver) {
    throw new AppError('DRIVER_NOT_FOUND')
  }

  const recentLoads = await loadsRepo.listLoadsByDriverId(id, { limit: 10 })

  return {
    ...withTelegramFlag(withTruckFuelPercent(withCurrentLoadProgress(driver))),
    recentLoads,
  }
}

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
import { whereNow } from '../driverChat/livePlace.js'
// The assignment itself belongs to fleet and stays there: the idle check,
// the row lock, the UNIQUE-violation translation. The dispatcher's button
// calls that same function -- a second copy of "who may drive what" would
// be a second rule, and the two would disagree the first time either
// changed.
import { assignDriver as assignTruckToDriver } from '../fleet/truckListings.service.js'

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

// The one place name every screen shows for the driver (X11): where they
// are now, not where they live. See livePlace.js's whereNow.
function withWhereNow(driver, now = new Date()) {
  return { ...driver, whereNow: whereNow(driver, driver.currentLoad, now) }
}

export async function listDrivers({ limit }) {
  const [rows, counts] = await Promise.all([
    driversRepo.listDrivers({ limit }),
    driversRepo.countDriverStatuses(),
  ])

  return { drivers: rows.map((d) => withWhereNow(withTelegramFlag(withCurrentLoadProgress(d)))), meta: { counts } }
}

export async function getDriverById(id) {
  const driver = await driversRepo.getDriverById(id)
  if (!driver) {
    throw new AppError('DRIVER_NOT_FOUND')
  }

  const recentLoads = await loadsRepo.listLoadsByDriverId(id, { limit: 10 })

  return {
    ...withWhereNow(withTelegramFlag(withTruckFuelPercent(withCurrentLoadProgress(driver)))),
    recentLoads,
  }
}

// Why a driverless truck cannot be taken, in the words the page shows.
// A fact about the truck, not advice: the dispatcher decides what to do
// about a truck in the shop.
const NOT_ASSIGNABLE = Object.freeze({
  active: 'Marked as working without a driver',
  maintenance: 'In the shop',
})

// Pure: rows in, options out. Exported for the tests.
export function truckOptionsFromRows(rows) {
  return rows.map((t) => {
    const assignable = t.status === 'idle'
    return {
      id: t.id,
      make: t.make,
      model: t.model,
      year: t.year,
      status: t.status,
      locationCity: t.locationCity ?? null,
      locationState: t.locationState ?? null,
      assignable,
      reason: assignable ? null : (NOT_ASSIGNABLE[t.status] ?? `Status: ${t.status}`),
    }
  })
}

async function requireDriver(id) {
  const driver = await driversRepo.getDriverById(id)
  if (!driver) throw new AppError('DRIVER_NOT_FOUND')
  return driver
}

export async function truckOptionsFor(driverId) {
  const driver = await requireDriver(driverId)
  return {
    // Said up front rather than discovered on click: a driver who already
    // has a truck gets DRIVER_HAS_TRUCK from the assignment anyway, but
    // the page can say so before anyone tries.
    driverHasTruck: Boolean(driver.truck),
    trucks: truckOptionsFromRows(await driversRepo.truckOptions()),
  }
}

export async function assignTruck({ driverId, truckId }) {
  // Checked here, not left to the foreign key: trucks.driver_id REFERENCES
  // drivers(id), so a missing driver would reach the client as a raw
  // 23503 instead of "Driver not found".
  await requireDriver(driverId)
  return assignTruckToDriver({ truckId, driverId })
}

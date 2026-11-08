// Where a driver on a run is RIGHT NOW, as the nearest city.
//
// drivers.current_city is where the driver was parked -- written on
// delivery (loads/whereabouts.js) and not moved by a run in progress.
// Read alone, it made a driver halfway to New York say "here in Seattle"
// (2026-10-05). During a run the place is the same one the map shows:
// tracking/position.js's positionFor along the lane, from dispatch to
// ETA, named by the nearest city on the list.
//
// One limit, said rather than hidden: this uses the lane arc, without the
// map's freeze for an open road event or a planned stop. A driver stopped
// on the shoulder may be named a few dozen miles further on than the map
// pins them. The driver's own report of the event (the chat) is the fact
// that matters there.

import { positionFor } from '../tracking/position.js'
import { nearestCity } from '../../../scripts/seed/facilities.js'

export function livePlace(load, now = new Date()) {
  if (!load?.dispatchedAt || !load?.etaAt) return null
  const pos = positionFor(load, now)
  if (!pos) return null
  const c = nearestCity(pos.lat, pos.lon)
  return c ? { city: c.city, state: c.state, progress: pos.progress } : null
}

// "Dallas, TX" -> { city, state }; null when the text is not that shape.
export function parsePlace(place) {
  const m = /^(.+),\s*([A-Z]{2})$/.exec(String(place ?? '').trim())
  return m ? { city: m[1], state: m[2] } : null
}

// THE answer to "where is this driver now" -- the one place every screen
// (Drivers list, driver page, map's parked trucks, the chat prompt, the bot)
// reads it from, so they cannot disagree (X11, 2026-11-08: New York on the
// map, Seattle on the Drivers page, both in the chat).
// Order: stopped for an open road event -> on a run (lane arc) -> where
// the driver was last parked (current_city) -> home base.
// `driver` needs currentCity/currentState/homeBaseCity/homeBaseState;
// `load` is the undelivered load (with dispatchedAt, etaAt, lane, and
// openEvent when one is open) or null.
export function whereNow(driver, load = null, now = new Date()) {
  const stopped = parsePlace(load?.openEvent?.place)
  if (stopped) return { city: stopped.city, state: stopped.state, onTheRoad: true, stopped: true }
  const live = livePlace(load, now)
  if (live) return { city: live.city, state: live.state, onTheRoad: true, stopped: false }
  if (driver?.currentCity && driver?.currentState) {
    return { city: driver.currentCity, state: driver.currentState, onTheRoad: false, stopped: false }
  }
  if (driver?.homeBaseCity && driver?.homeBaseState) {
    return { city: driver.homeBaseCity, state: driver.homeBaseState, onTheRoad: false, stopped: false }
  }
  return null
}

// The context every reader gets (prompt, /status, the bot): the parked
// place kept as parkedCity/parkedState, and currentCity/currentState
// moved to where whereNow says the driver is.
export function withLivePlace(context, now = new Date()) {
  if (!context) return context
  const { driver, load } = context
  const here = whereNow(driver, load, now)
  return {
    ...context,
    driver: {
      ...driver,
      parkedCity: driver.currentCity ?? null,
      parkedState: driver.currentState ?? null,
      ...(here ? { currentCity: here.city, currentState: here.state } : {}),
      onTheRoad: Boolean(here?.onTheRoad),
      ...(here?.stopped ? { stopped: true } : {}),
    },
  }
}

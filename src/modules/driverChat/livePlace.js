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

// The context every reader gets (prompt, /status, the bot): the parked
// place kept as parkedCity/parkedState, and currentCity/currentState
// moved to where the run has got to. A driver with no run is where they
// were parked.
export function withLivePlace(context, now = new Date()) {
  if (!context) return context
  const { driver, load } = context
  const live = livePlace(load, now)
  return {
    ...context,
    driver: {
      ...driver,
      parkedCity: driver.currentCity ?? null,
      parkedState: driver.currentState ?? null,
      ...(live ? { currentCity: live.city, currentState: live.state, onTheRoad: true } : { onTheRoad: false }),
    },
  }
}

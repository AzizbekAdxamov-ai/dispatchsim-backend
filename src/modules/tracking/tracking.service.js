// Shapes the tracking board: raw rows in, positioned rows out.
//
// The page needs three honest answers per load: where is it (lat/lon on
// the lane's arc), how far along (progress + miles left), and is it late.
// positionFor() computes all three from the same timestamps, so the map,
// the bar and the ETA line can never disagree with one another.

import * as repo from './tracking.repository.js'
import { positionFor } from './position.js'

export async function inTransitBoard() {
  const rows = await repo.inTransitBoard()

  const positioned = rows
    .map((load) => {
      const position = positionFor(load)
      if (!position) return null
      return {
        id: load.id,
        status: load.status,
        originCity: load.originCity,
        originState: load.originState,
        destinationCity: load.destinationCity,
        destinationState: load.destinationState,
        distanceMi: load.distanceMi,
        rateUsd: load.rateUsd,
        etaAt: load.etaAt,
        promisedEtaAt: load.promisedEtaAt,
        dispatchedAt: load.dispatchedAt,
        driver: load.driver, // { id, name } or null
        truck: load.truck, // { id, make, model } or null
        openEvent: load.openEvent,
        // Position fields, one flat level down so the page reads one shape.
        progress: position.progress,
        late: position.late,
        lat: position.lat,
        lon: position.lon,
        distanceRemainingMi: position.distanceRemainingMi,
        laneHaversineMi: position.laneHaversineMi,
        // Lane endpoints with coordinates, for drawing the route line.
        originPos: position.origin,
        destinationPos: position.destination,
      }
    })
    .filter(Boolean)

  return {
    loads: positioned,
    meta: {
      count: positioned.length,
      lateCount: positioned.filter((l) => l.late).length,
      openEventCount: positioned.filter((l) => l.openEvent).length,
      // Server clock at compute time -- the page's poll freshness check
      // reads this instead of trusting the browser's clock, which is in a
      // different timezone and possibly wrong.
      computedAt: new Date().toISOString(),
    },
  }
}

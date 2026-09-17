// Shapes the tracking board: raw rows in, positioned rows out.
//
// The page needs three honest answers per load: where is it (lat/lon on
// the lane's arc), how far along (progress + miles left), and is it late.
// positionFor() computes all three from the same timestamps, so the map,
// the bar and the ETA line can never disagree with one another.

import * as repo from './tracking.repository.js'
import { positionFor, laneEndpoints } from './position.js'
import { CITIES } from '../../../scripts/seed/cities.js'

// Why a row could not be placed. Mirrors the two things positionFor()
// refuses on: a lane endpoint outside the closed CITIES set (a row written
// before cities.js was the source of truth), or an eta_at/dispatched_at
// pair positionFor can't turn into a fraction (missing, or eta_at at or
// before dispatched_at). City is checked first because it's the more
// common cause and the more actionable one for whoever reads the count.
function excludeReason(load) {
  const { origin, destination } = laneEndpoints(load)
  if (!origin || !destination) return 'unmapped-city'
  return 'bad-eta'
}

// Splits the board's raw rows into loads the map can place and loads it
// can't, with a reason for each miss. Pulled out of inTransitBoard() as
// its own pure function (rows in, shape out, no query) so the exclusion
// bookkeeping can be unit-tested without a database -- the same reason
// position.js's own functions are exported directly instead of hiding
// behind the endpoint.
export function shapeBoard(rows, now = new Date()) {
  const positioned = []
  const excluded = []

  for (const load of rows) {
    const position = positionFor(load, now)
    if (!position) {
      // Loud, not silent -- see loadBoard.repository.js's buildBaseCte.
      // A load that quietly drops off the board reads as "nothing to see
      // here" when it's actually a data problem (an unmapped city, a bad
      // ETA) that someone should notice, the same "silently wrong instead
      // of loudly wrong" pattern that let the 14,676 mi deadhead sit
      // unnoticed. Here "loud" means counted and logged, not thrown --
      // one bad row must not take the whole board down for every other
      // truck on the road.
      excluded.push({ id: load.id, reason: excludeReason(load) })
      continue
    }
    positioned.push({
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
      openEvent: Boolean(load.eventOpenedAt),
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
    })
  }

  return { positioned, excluded }
}

export async function inTransitBoard() {
  const rows = await repo.inTransitBoard()
  const { positioned, excluded } = shapeBoard(rows)

  if (excluded.length > 0) {
    // One line per call, not one per row -- Tracking.jsx polls this every
    // 10s (see its own POLL_MS), and a per-row console.error would flood
    // the log with the same handful of stale rows over and over. Loud
    // enough to notice, quiet enough to read.
    console.error(
      `[tracking] ${excluded.length} load(s) excluded from the board: `
      + excluded.map((x) => `${x.id} (${x.reason})`).join(', '),
    )
  }

  const excludedReasons = excluded.reduce((acc, x) => {
    acc[x.reason] = (acc[x.reason] ?? 0) + 1
    return acc
  }, {})

  return {
    loads: positioned,
    meta: {
      count: positioned.length,
      lateCount: positioned.filter((l) => l.late).length,
      openEventCount: positioned.filter((l) => l.openEvent).length,
      // Loads the board fetched but couldn't place -- see shapeBoard. The
      // page shows this count instead of letting the rows vanish
      // unremarked.
      excludedCount: excluded.length,
      excludedReasons,
      // Server clock at compute time -- the page's poll freshness check
      // reads this instead of trusting the browser's clock, which is in a
      // different timezone and possibly wrong.
      computedAt: new Date().toISOString(),
    },
  }
}

// The map's standing furniture: every city the seed can route through.
//
// This is deliberately a SEPARATE endpoint from the board, not a field on
// it. The board is polled every 10s because trucks move; the city set
// changes only when cities.js changes, which is a deploy. Shipping it with
// every poll would re-send an unchanging 61-entry list six times a minute.
//
// It is served rather than copied into the frontend because these are
// COORDINATES. constants/zones.js can afford a copy in both packages -- a
// wrong zone key fails loudly. A wrong latitude does not: it puts a
// plausible-looking dot in the wrong state and nothing downstream notices,
// which is the exact reason cities.js is a hand-checked file in the first
// place (see its header). One copy, on the server, is the only safe shape.
export function mapReference() {
  return {
    cities: CITIES.map(({ city, state, lat, lon }) => ({ city, state, lat, lon })),
  }
}

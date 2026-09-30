// Shapes the tracking board: raw rows in, positioned rows out.
//
// The page needs three honest answers per load: where is it (lat/lon on
// the lane's arc), how far along (progress + miles left), and is it late.
// positionFor() computes all three from the same timestamps, so the map,
// the bar and the ETA line can never disagree with one another.

import * as repo from './tracking.repository.js'
import * as loadsRepo from '../loads/loads.repository.js'
import { positionFor, laneEndpoints } from './position.js'
import { AppError } from '../../lib/errors.js'
import { CITIES, roadMiles } from '../../../scripts/seed/cities.js'
import { resolveCity, cityCompletions, rankPostings, hotLanes } from './laneSearch.js'
import { simplifyPath } from '../routing/simplify.js'
import * as routingService from '../routing/routing.service.js'

// How much a board-poll route line may deviate (in miles, simplify.js's
// own unit) from the full OSRM geometry before the map's own pixels would
// show the difference -- the tolerance simplifyPath() is called with
// below, so /tracking's 10s poll carries a few dozen points per lane
// instead of the 2,000+ osrm.js now fetches (see its own header), while
// the marker itself still walks the FULL geometry via position.js
// (unchanged -- see positionFor's call below, which is handed
// `load.routeGeometry` straight off the repository, not the simplified
// copy this constant is for).
//
// CALCULATED, not picked: derived from the SAME projection constants the
// board map itself renders with (frontend/src/data/usMap.js's
// PROJECTION_BOUNDS and frontend/src/utils/usProjection.js's VIEW_W/PAD/
// mercY -- duplicated here as plain numbers, since this is the backend
// and cannot import a frontend file; see the numbers cited below so a
// change on either side is at least visible as a stale comment, not a
// silent drift).
//
//   1. usProjection.js's makeProject() fits PROJECTION_BOUNDS into a
//      VIEW_W=740 x VIEW_H=400 viewBox with PAD=16 on every side, at
//      whichever of the two axis scales is smaller (the tighter fit wins,
//      same as `background-size: contain`). For this exact bounds box
//      (minLon -124.7336, maxLon -66.9819, minY/maxY = mercY(25.2991) /
//      mercY(56.9567)) the Y axis is the tighter fit:
//        lonSpan  = 57.7517 deg
//        yMercSpan = mercY(56.9567) - mercY(25.2991) = 43.4672
//        scaleX = (740 - 2*16) / lonSpan  = 12.259 px/deg
//        scaleY = (400 - 2*16) / yMercSpan =  8.466 px/deg  <- smaller, wins
//      So the map actually renders at 8.466 SVG px per degree of
//      longitude, not 12.259 -- using the wrong (wider) one here would
//      UNDERSTATE how many miles a pixel covers and simplify too
//      little.
//   2. Miles per degree of LONGITUDE is latitude-dependent (a degree of
//      longitude shrinks toward the poles); this board spans 25.3 deg to
//      57.0 deg latitude, so the midpoint (41.128 deg -- roughly the
//      Kansas/Nebraska line, a reasonable single number for a board that
//      shows the whole country) is used: 69.172 * cos(41.128 deg) =
//      52.08 mi/deg.
//   3. Miles per SVG pixel, at that midpoint: 52.08 / 8.466 = 6.15 mi/px.
//   4. Tolerance: a deviation of HALF a pixel is what "the eye cannot
//      tell the difference" means on a raster/vector display -- anything
//      smaller never resolves into a visibly different pixel column no
//      matter how the SVG viewBox is finally scaled to the actual screen.
//      0.5 * 6.15 = 3.075 mi, rounded DOWN (not to the nearest whole
//      number) to 3 -- a smaller tolerance keeps MORE points, so rounding
//      down is the conservative direction if this estimate is ever a
//      little off.
const BOARD_TOLERANCE_MI = 3

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
    // load.routeGeometry: the LEFT JOINed lane_routes.geometry column
    // (tracking.repository.js) -- null for a lane never searched, an
    // array of [lon,lat] pairs for one that has been. positionFor()
    // itself decides route-vs-arc; this call site only forwards what the
    // query already fetched.
    const position = positionFor(load, now, load.routeGeometry)
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
      // { id, name, dutyStatus, hosRemainingMin, hoursTodayMin,
      //   hoursWeekMin } or null -- the HOS columns syncDriverHos writes.
      driver: load.driver,
      stopPlanStatus: load.stopPlanStatus ?? null,
      stopPlanFacts: load.stopPlanFacts ?? [],
      truck: load.truck, // { id, make, model } or null
      openEvent: Boolean(load.eventOpenedAt),
      // The facility the load is AT right now, or null between stops --
      // straight off tracking.repository.js's own currentStop subselect,
      // minus the lat/lon it carries only for position.js's freeze (the
      // page draws the marker at the SAME point positionFor() already
      // returned as lat/lon above; a second coordinate pair here would
      // just be a second, possibly-stale copy of the same fact).
      currentStop: load.currentStop
        ? {
          facilityName: load.currentStop.facilityName,
          city: load.currentStop.city,
          state: load.currentStop.state,
          reason: load.currentStop.reason,
          arrivedAt: load.currentStop.arrivedAt,
          departedAt: load.currentStop.departedAt,
          gallons: load.currentStop.gallons,
          costUsd: load.currentStop.costUsd,
        }
        : null,
      // The load's whole planned run of stops (see tracking.repository.js's
      // own header on why this is embedded here rather than a separate
      // endpoint) -- [] for a load dispatched before stop planning existed,
      // or one whose lane/truck lookup failed at dispatch time (said in
      // stopPlanStatus/stopPlanFacts above, never thrown; see
      // dispatch.service.js's planAndSaveStops).
      plannedStops: load.plannedStops ?? [],
      // Position fields, one flat level down so the page reads one shape.
      progress: position.progress,
      late: position.late,
      lat: position.lat,
      lon: position.lon,
      distanceRemainingMi: position.distanceRemainingMi,
      // Lane endpoints with coordinates, for drawing the route line.
      originPos: position.origin,
      destinationPos: position.destination,
      // A SIMPLIFIED copy of the polyline (not the full OSRM geometry --
      // see BOARD_TOLERANCE_MI's own header above for why), so the page
      // can draw the actual road's shape instead of just the
      // straight-line endpoints above -- null when no route has been
      // fetched for this lane yet (GET /tracking/route, or the new
      // GET /tracking/loads/:id/route, fetches and caches one on demand).
      // The marker's OWN position, computed above, still walked the FULL
      // geometry (positionFor() was handed `load.routeGeometry` straight
      // off the repository a few lines up, before this simplification
      // ever runs) -- simplifying is a board-payload-size decision, not
      // an accuracy one, and it never touches where the dot itself sits.
      routeGeometry: load.routeGeometry ? simplifyPath(load.routeGeometry, BOARD_TOLERANCE_MI) : null,
      // States the contract of the field above rather than leaving the
      // page to assume it: this is always the simplified copy when
      // present, never the full one. A load's own detail panel fetches
      // the full geometry separately (GET /tracking/loads/:id/route,
      // 'detail: full' in ITS OWN response) when the user actually
      // selects that load -- see tracking.controller.js's loadRoute.
      routeGeometryDetail: 'simplified',
      // 'route' | 'arc' from positionFor() says which geometry the marker
      // ITSELF walked -- stated here rather than left for the page to
      // infer from routeGeometry's presence, because the two can disagree
      // (a route with fewer than 2 points is present but unusable, and
      // positionFor() already fell back to the arc for it).
      geometrySource: position.geometrySource,
    })
  }

  return { positioned, excluded }
}

// The idle trucks as map points. Pure: rows in, features out, no query --
// testable without a database, the same reason shapeBoard is.
//
// A truck rides on its DRIVER's last-known coordinates; a truck with no
// driver, or one whose driver has never been placed, has no position and
// is dropped -- an invented lat/lon would be a fact this schema does not
// have. A truck whose driver IS running a load never reaches this
// function (the SQL's NOT EXISTS arms exclude it), so a working truck is
// never drawn twice: its dot comes from its load, once.
export function idleTrucksToBoard(trucks) {
  return trucks
    .map((t) => {
      const lat = t.driver?.lat
      const lon = t.driver?.lon
      // Number.isFinite alone would let null through: Number(null) is 0,
      // and a truck "parked" at lat 0, lon 0 is in the Gulf of Guinea.
      // Nullish first, then finite.
      if (lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null
      return {
        id: t.id,
        // 'idle' is its own kind of row, not a load status -- the map and
        // the list can tell the two apart without guessing from fields
        // a parked truck does not have.
        kind: 'idle',
        truck: { id: t.id, make: t.make, model: t.model, year: t.year },
        driver: t.driver
          ? {
            id: t.driver.id,
            name: t.driver.name,
            dutyStatus: t.driver.dutyStatus,
            hosRemainingMin: t.driver.hosRemainingMin,
          }
          : null,
        city: t.driver?.currentCity ?? t.locationCity ?? null,
        state: t.driver?.currentState ?? t.locationState ?? null,
        lat: Number(lat),
        lon: Number(lon),
      }
    })
    .filter(Boolean)
}

export async function inTransitBoard() {
  const rows = await repo.inTransitBoard()
  const { positioned, excluded } = shapeBoard(rows)
  const idle = idleTrucksToBoard(await repo.idleTrucks())

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
    // The trucks with nothing on them, as their own list: the map draws
    // them in the idle style, the list can label them "No load assigned",
    // and neither has to infer anything from a half-populated load row.
    idleTrucks: idle,
    meta: {
      count: positioned.length,
      lateCount: positioned.filter((l) => l.late).length,
      openEventCount: positioned.filter((l) => l.openEvent).length,
      // Loads the board fetched but couldn't place -- see shapeBoard. The
      // page shows this count instead of letting the rows vanish
      // unremarked.
      excludedCount: excluded.length,
      excludedReasons,
      idleTruckCount: idle.length,
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

// The fleet map's A→B lane search. Reads like the load board's own
// filters: optional origin, optional destination, both resolved against
// the closed city set -- an unknown city is a 400 (UNKNOWN_CITY), never
// a silent empty result, because "no freight" and "not a city we map"
// are different answers to a dispatcher choosing where to send a truck.
//
// Three result blocks:
//   lane    -- the resolved lane itself (miles via cities.js's
//              roadMiles(), the same mileage the board stores); null
//              unless BOTH ends are named -- an origin-only search has
//              no lane to draw yet
//   results -- ranked open postings: exact lane first, then one-end
//              matches, then the market's best (see laneSearch.js)
//   hotLanes -- the busiest open lanes. Served both for the initial
//              no-search view (open the page, see the market) and after
//              clearing the boxes -- an empty search means "show me the
//              market", which is an answer, not an error.
export async function searchLane({ origin, destination }) {
  const originCity = origin ? resolveCity(origin) : null
  if (origin && !originCity) throw new AppError('UNKNOWN_CITY')
  const destinationCity = destination ? resolveCity(destination) : null
  if (destination && !destinationCity) throw new AppError('UNKNOWN_CITY')

  if (!originCity && !destinationCity) {
    const postings = await repo.openPostings()
    return { lane: null, results: [], hotLanes: hotLanes(postings, 6) }
  }

  const lane = originCity && destinationCity
    ? {
      origin: { city: originCity.city, state: originCity.state, lat: originCity.lat, lon: originCity.lon },
      destination: { city: destinationCity.city, state: destinationCity.state, lat: destinationCity.lat, lon: destinationCity.lon },
      distanceMi: roadMiles(originCity, destinationCity),
    }
    : null

  const postings = await repo.openPostings()
  const anchor = lane ? lane.origin : originCity
  const results = rankPostings(postings, { lane, anchor, limit: 6 })

  return {
    lane,
    results,
    hotLanes: [],
  }
}

// The search box's type-ahead. Deliberately NOT a fuzzy matcher over an
// unbounded gazetteer: the freight world this simulator routes through
// is cities.js's closed set, so completions come from the same list the
// board's own filters use -- a city that completes here is one the lane
// search can actually resolve.
export function searchCompletions(query) {
  return { completions: cityCompletions(query, 6) }
}

// GET /tracking/loads/:loadId/route -- the FULL, unsimplified road
// geometry for ONE load, fetched once when a dispatcher actually selects
// it on the board (never on the 10s poll -- see BOARD_TOLERANCE_MI's own
// header on why the board itself only ever ships the simplified copy).
//
// Reads the load's own lane (loads.repository's getLoadById, the same
// row /loads/:id already serves) rather than requiring the caller to
// already know the origin/destination cities -- a dispatcher selecting a
// load off the board only has its id. Routed through
// routing.service.js's own read-through cache exactly like GET
// /tracking/route (tracking.controller.js's `route` handler) -- a lane
// already searched by EITHER endpoint is reused by both, and a lane no
// one has ever searched is fetched here on the spot rather than answered
// with an empty result.
//
// Two distinct failure modes, both loud (never a silent empty array --
// see routing.service.js's own header on why an OSRM failure is never
// swallowed):
//   - the load id itself doesn't exist -> LOAD_NOT_FOUND, the same error
//     GET /loads/:id already uses for the same fact.
//   - the load exists but its lane can't be routed (an unmapped city, or
//     OSRM refusing/timing out) -> whatever AppError routingService.
//     routesFor() throws (UNKNOWN_CITY / ROUTE_UNAVAILABLE), unmodified --
//     duplicating that error handling here would be a second place for
//     the two to drift apart.
export async function loadRoute(loadId) {
  const load = await loadsRepo.getLoadById(loadId)
  if (!load) throw new AppError('LOAD_NOT_FOUND')

  const routes = await routingService.routesFor(
    { city: load.originCity, state: load.originState },
    { city: load.destinationCity, state: load.destinationState },
  )

  // routesFor() always throws rather than resolving with an empty array
  // (see its own header) -- this guard is defensive, not a path this
  // module expects to hit, kept so a future change there that DID start
  // returning [] would fail loudly here instead of handing the page a
  // geometry: undefined it has to guess about.
  const primary = routes[0]
  if (!primary) throw new AppError('ROUTE_UNAVAILABLE', 'No route available for this lane')

  return { geometry: primary.geometry, detail: 'full' }
}

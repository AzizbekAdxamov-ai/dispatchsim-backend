// Populates `facilities` (migration 035) by walking every cached
// lane_routes (034) geometry and placing fuel stops, truck stops, rest
// areas and repair shops along it.
//
//   node scripts/generate-facilities.js
//
// Idempotent by CONSTRAINT, not by memory: every id is derived from the
// point's own rounded coordinates (scripts/seed/facilities.js's
// facilityId()), and INSERT_FACILITY_SQL is ON CONFLICT (id) DO NOTHING
// -- running this twice over the same cached routes inserts zero rows the
// second time, the same idempotency pattern scripts/warm-routes.js
// already relies on for lane_routes.
//
// Reads lane_routes through routing.repository.js's listAllRoutes() and
// writes facilities through facilities.repository.js's insertMany() --
// this script owns no SQL of its own, same as reset-company.js/
// warm-routes.js.

import 'dotenv/config'
import { pool, withTransaction } from '../src/db/pool.js'
import { listAllRoutes } from '../src/modules/routing/routing.repository.js'
import * as facilitiesRepo from '../src/modules/facilities/facilities.repository.js'
import {
  placeAlongRoute, placeAroundCity, countTargetPoints, SPACING_MI, MERGE_RADIUS_MI,
  facilityId, facilityRng, nearestCity, pickKind, fuelPriceCents,
  pickAmenities, pickUnusedName, restAreaName, mulberry32, fnv1aSeed,
} from './seed/facilities.js'
import { CITIES } from './seed/cities.js'
import { TRUCK_STOP_NAMES, REPAIR_SHOP_NAMES } from './seed/vocabulary.js'

const FUEL_SELLING_KINDS = new Set(['fuel', 'truck_stop'])

// Turns one accepted {lat, lon} candidate into a full facilities row.
// Everything about it -- kind, name, price, amenities -- is drawn from a
// PRNG seeded off the point's OWN id (facilityRng), so the same point
// generates the exact same row whichever route discovered it and on
// whichever run: this is the "narx seed'dan barqaror" requirement (the
// plan's own wording), extended to every field a run picks, not price
// alone.
//
// `usedNames` dedupes names WITHIN one route (facilities.js's own header
// on pickUnusedName/restAreaName explains why) -- three separate sets,
// because fuel and truck_stop draw from the SAME pool (TRUCK_STOP_NAMES)
// and must not repeat against each other either, while repair and
// rest_area each have their own naming scheme.
function buildRow(point, usedNames) {
  const id = facilityId(point.lat, point.lon)
  const rng = facilityRng(id)
  const kind = pickKind(rng)
  const city = nearestCity(point.lat, point.lon)

  const name = kind === 'rest_area'
    ? restAreaName(city.city, usedNames.restArea)
    : kind === 'repair'
      ? pickUnusedName(rng, REPAIR_SHOP_NAMES, usedNames.repair)
      : pickUnusedName(rng, TRUCK_STOP_NAMES, usedNames.truckStopLike)

  return {
    id,
    kind,
    name,
    lat: point.lat,
    lon: point.lon,
    nearCity: city.city,
    nearState: city.state,
    fuelPriceCents: FUEL_SELLING_KINDS.has(kind) ? fuelPriceCents(rng) : null,
    amenities: pickAmenities(rng, kind),
  }
}

async function main() {
  const routes = await listAllRoutes()

  if (routes.length === 0) {
    // Not a failure any more: the city pass below fills the map whether
    // or not anybody has warmed a lane. It IS worth saying, because a
    // corridor with no cached route gets no stops along it.
    console.log('no routes cached yet (`npm run routes:warm` adds them) -- placing city stops only')
  }

  const existingRows = await facilitiesRepo.listAll()
  // Running list of every point already known -- both rows already in
  // the database AND every point this run has itself accepted so far, per
  // placeAlongRoute's own header: two routes placed in the SAME run must
  // share a corridor too, not just a route placed against what was
  // already there before this run started.
  const existingPoints = existingRows.map((row) => ({ lat: Number(row.lat), lon: Number(row.lon) }))

  let routesRead = 0
  let candidatesTotal = 0
  let mergedTotal = 0
  let createdTotal = 0
  const failures = []

  for (const route of routes) {
    routesRead += 1
    const label = `${route.originCity}, ${route.originState} -> ${route.destinationCity}, ${route.destinationState} (alt ${route.alternativeIndex})`

    try {
      const candidates = placeAlongRoute(route.geometry, {
        spacingMi: SPACING_MI,
        mergeRadiusMi: MERGE_RADIUS_MI,
        existing: existingPoints,
      })
      const targetCount = countTargetPoints(route.geometry, SPACING_MI)
      mergedTotal += Math.max(0, targetCount - candidates.length)
      candidatesTotal += candidates.length

      if (candidates.length === 0) continue

      const usedNames = { truckStopLike: new Set(), repair: new Set(), restArea: new Set() }
      const rows = candidates.map((point) => buildRow(point, usedNames))

      // eslint-disable-next-line no-await-in-loop -- one route's insert
      // batch at a time, same reasoning as warm-routes.js's own
      // per-lane loop: there is nothing here worth parallelizing against
      // a handful-to-low-hundreds of total routes.
      const inserted = await withTransaction((client) => facilitiesRepo.insertMany(client, rows))
      createdTotal += inserted

      // Fold every ACCEPTED point (not just the ones this run actually
      // inserted) into existingPoints -- a point placeAlongRoute already
      // decided is new for this route must also stop the NEXT route from
      // placing a second stop on top of it, regardless of whether the
      // database happened to already have that exact id.
      for (const point of candidates) existingPoints.push(point)
    } catch (err) {
      failures.push({ lane: label, message: err.message })
      console.error(`  FAILED  ${label}: ${err.message}`)
    }
  }

  // ---- second pass: every seed city gets its own ring of stops -------
  //
  // Deterministic per city (the rng is seeded from "city, ST"), so a
  // re-run places the same ring and inserts nothing new -- the same
  // idempotency the route pass gets from the point-derived id.
  let cityCandidates = 0
  let cityCreated = 0
  for (const city of CITIES) {
    const rng = mulberry32(fnv1aSeed(`${city.city}, ${city.state}`))
    const points = placeAroundCity(city, { rng, existing: existingPoints })
    cityCandidates += points.length
    if (points.length === 0) continue
    const usedNames = { truckStopLike: new Set(), repair: new Set(), restArea: new Set() }
    const rows = points.map((point) => buildRow(point, usedNames))
    try {
      // eslint-disable-next-line no-await-in-loop -- one city at a time,
      // same reasoning as the route loop above.
      cityCreated += await withTransaction((client) => facilitiesRepo.insertMany(client, rows))
      for (const point of points) existingPoints.push(point)
    } catch (err) {
      failures.push({ lane: `${city.city}, ${city.state}`, message: err.message })
      console.error(`  FAILED  ${city.city}, ${city.state}: ${err.message}`)
    }
  }

  console.log('')
  console.log(`${CITIES.length} city ring(s): ${cityCandidates} candidate stop(s), ${cityCreated} newly created.`)
  console.log(`${routesRead} route(s) read, ${candidatesTotal} candidate stop(s) considered.`)
  console.log(`${createdTotal} route facility row(s) newly created, ${mergedTotal} candidate(s) merged into an existing facility.`)
  if (failures.length > 0) {
    console.log(`${failures.length} route(s) failed:`)
    for (const f of failures) console.log(`  - ${f.lane}: ${f.message}`)
  }

  await pool.end()
  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('generate-facilities aborted:', err.message)
  process.exit(1)
})

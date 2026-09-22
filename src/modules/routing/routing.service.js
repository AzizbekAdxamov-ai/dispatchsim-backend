// Read-through cache in front of OSRM: a lane's routes come from
// lane_routes if they're already there, and from OSRM (saved for next
// time) if they're not.
//
// OSRM failures are NEVER caught and replaced with a fallback here --
// that would be the exact "silently wrong instead of loudly wrong"
// pattern this codebase keeps naming and keeps removing (see
// tracking.service.js's shapeBoard, road_miles' NULL guard, etc). A
// dispatcher who asks for a route and gets a wrong one silently has no
// way to know it's wrong; one who gets a 503 knows to try again.

import { findCity } from '../../../scripts/seed/cities.js'
import { AppError } from '../../lib/errors.js'
import { withTransaction } from '../../db/pool.js'
import { fetchRoutes } from './osrm.js'
import * as repo from './routing.repository.js'

// point: { city, state, lat?, lon? }. Coordinates are ALWAYS resolved
// through the closed CITIES set here, never trusted from the caller --
// cities.js is the hand-checked source of truth (see its own header on
// why a wrong coordinate is the one kind of bug nothing downstream
// catches), and a caller-supplied lat/lon would bypass that entirely.
function resolveCity(point) {
  const city = findCity(point?.city, point?.state)
  if (!city) throw new AppError('UNKNOWN_CITY')
  return city
}

// origin/destination: { city, state, lat?, lon? } (lat/lon ignored -- see
// resolveCity). Returns [{ alternativeIndex, geometry, distanceMi,
// durationMin, roadRefs }], 0-indexed in rank order, whether the answer
// came from the cache or from OSRM just now.
export async function routesFor(origin, destination) {
  const originCity = resolveCity(origin)
  const destinationCity = resolveCity(destination)

  const lane = {
    origin: { city: originCity.city, state: originCity.state },
    destination: { city: destinationCity.city, state: destinationCity.state },
  }

  // Cache read first, no exceptions: a lane already fetched never touches
  // OSRM again, which is the entire point of the table (034's own header:
  // "keshlamasdan har poll'da qayta so'rash uni bosib qo'yar edi").
  const cached = await repo.getRoutes(lane)
  if (cached.length > 0) return cached

  // Not cached: ask OSRM. Any failure here (timeout, HTTP error, a
  // non-'Ok' response code) is an AppError thrown by fetchRoutes -- it
  // propagates straight out of this function. Wrapping it in a try/catch
  // that returned [] or a stale/synthetic route would be the silent
  // failure this module exists to not have.
  const fetched = await fetchRoutes(originCity, destinationCity)

  // One transaction for the whole alternative set -- see saveRoutes()'s
  // own reasoning for why partial-write is worse than no write.
  await withTransaction((client) => repo.saveRoutes(client, lane, fetched))

  return fetched.map((route, i) => ({ alternativeIndex: i, ...route }))
}

// Bypasses the cache read entirely -- unlike routesFor() above, this
// ALWAYS asks OSRM and force-overwrites whatever is already cached for
// the lane (repo.saveRoutesForce's UPSERT, not saveRoutes()'s
// ON-CONFLICT-DO-NOTHING). routesFor() must stay a read-through cache for
// the live request path (GET /tracking/route, GET
// /tracking/loads/:id/route) -- re-fetching an already-cached lane on
// every call would hammer a public demo server for no reason, exactly
// what 034's own migration comment warns against.
//
// This function exists ONLY for scripts/warm-routes.js's --refresh flag:
// migrating rows fetched back when osrm.js requested overview=simplified
// (coarse -- see its own header) to the overview=full geometry it asks
// for now. It is meant to be run once, by an operator, from a terminal --
// never from a request handler, and nothing in src/modules/ calls it.
export async function refreshRoutes(origin, destination) {
  const originCity = resolveCity(origin)
  const destinationCity = resolveCity(destination)

  const lane = {
    origin: { city: originCity.city, state: originCity.state },
    destination: { city: destinationCity.city, state: destinationCity.state },
  }

  const fetched = await fetchRoutes(originCity, destinationCity)
  await withTransaction((client) => repo.saveRoutesForce(client, lane, fetched))

  return fetched.map((route, i) => ({ alternativeIndex: i, ...route }))
}

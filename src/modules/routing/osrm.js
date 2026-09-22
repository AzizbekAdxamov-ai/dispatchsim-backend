// One HTTP round trip to OSRM's public demo router, and the parsing that
// turns its response into the shape routing.repository.js writes to
// lane_routes. No database here -- routing.service.js owns the cache
// decision, this file only knows how to ask OSRM and how to read what it
// says back.
//
// router.project-osrm.org is a shared community demo instance with no
// SLA and no API key: it can be slow, it can 429, it can be down. Every
// failure here is thrown as an AppError (ROUTE_UNAVAILABLE) -- never
// swallowed into an empty array or a null route, which would draw a
// blank map and look like "no road exists" instead of "the router did
// not answer".

import { AppError } from '../../lib/errors.js'

const OSRM_BASE_URL = 'https://router.project-osrm.org'

// The exact definition of the international mile in meters (1 mi =
// 1,609.344 m, the 1959 international agreement all US/UK unit systems
// use). Not a rounded approximation -- OSRM's distance comes back in
// meters and this is the one number that converts it without drifting.
const METERS_PER_MILE = 1609.344

// A hung TCP connection to a public demo server would otherwise block
// whatever request triggered the fetch forever -- there is nothing else
// here to time it out. 8 seconds is generous for a single driving-route
// request over a normal connection (this project's chat client, which
// talks to a paid API expected to be reliable, retries at MUCH shorter
// per-attempt windows -- see scripts/seed/aiClient.js) but still short
// enough that GET /tracking/route fails inside a normal HTTP client's own
// timeout instead of past it.
const FETCH_TIMEOUT_MS = 8000

// How many of a route's road refs to keep. The UI wants to say what a
// lane runs on ("I-40, I-25"), not print a turn-by-turn manifest -- and a
// route can carry a dozen distinct refs (on-ramps, business loops, a
// state highway for the last two miles). 3 is enough to name the
// interstates that actually define a long-haul lane; sorted by distance
// covered below, so it's the three biggest, not the first three OSRM
// happened to list.
const MAX_ROAD_REFS = 3

// How many alternative routes to keep. Matches the CHECK on
// lane_routes.alternative_index (034): 0..2, three rows. OSRM's own
// `alternatives` option has no documented cap, and slicing here means a
// response with more than three routes can never reach the INSERT and
// fail the CHECK instead of failing this function with a clear error.
const MAX_ALTERNATIVES = 3

// OSRM returns highway refs like "I 45" (space) -- US dispatchers write
// "I-45" (hyphen), and that's the form road_refs is meant to hold.
// Interstate/US-route/state-route refs all follow the same
// LETTERS-then-DIGITS shape ("I 45", "US 59", "TX 8"), so one regex
// covers all three instead of special-casing "I".
function normalizeRef(ref) {
  return ref.replace(/^([A-Za-z]+)\s+(\d)/, '$1-$2')
}

// legs[].steps[].ref -> a short, ranked list of road refs.
//
// A route can carry the same ref across many non-adjacent steps (an
// interstate crossed, left, rejoined), and the raw step list can run to
// dozens of entries for a cross-country route. Summing each ref's own
// step distances and keeping the biggest MAX_ROAD_REFS answers "what did
// this route actually run on" -- "I-40, I-25" for a route that spends
// hundreds of miles on each, not "I-45, US-59, TX-8" for the three refs
// nearest the origin. Empty/whitespace-only refs (unnamed local roads,
// which OSRM leaves blank) are dropped rather than kept as "".
function extractRoadRefs(route) {
  const distanceByRef = new Map()
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const raw = step.ref
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const ref = normalizeRef(raw.trim())
      distanceByRef.set(ref, (distanceByRef.get(ref) ?? 0) + (step.distance ?? 0))
    }
  }
  return [...distanceByRef.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ROAD_REFS)
    .map(([ref]) => ref)
}

// origin/destination: { lat, lon }. Returns up to MAX_ALTERNATIVES routes,
// in OSRM's own routes[] order (index 0 is the primary route), each as
// { geometry, distanceMi, durationMin, roadRefs }.
//
// geometry stays as OSRM's own [[lon,lat], ...] GeoJSON coordinate order
// -- NOT the {lat,lon} shape position.js's own functions use. Converting
// here would be a silent format change nothing downstream asked for;
// position.js's pointAlongPath is written to read [lon,lat] pairs
// directly because that is what gets stored in lane_routes.geometry
// verbatim.
//
// overview=full, not OSRM's default 'simplified': 'simplified' runs the
// Douglas-Peucker simplification OSRM does internally for a map-preview
// zoom level, which is aggressive enough to visibly cut across fields at
// city zoom -- MEASURED on Dallas, TX -> Orlando, FL (1,085 mi, this
// project's own longest seeded lane's rough order): 'simplified' answered
// with roughly 50 points (~1 every 22 mi, coarse enough that the drawn
// line leaves I-30/I-10-ish corridors and cuts the corner across open
// country at any zoom closer than "whole country"), while 'full' answered
// with 2,000+ points for the SAME lane (the response was cut off at OSRM's
// own 50,000-character reply before the array even finished, so the true
// count is higher still). 'full' is the one that actually follows the
// interstate; the tradeoff is a heavier response (roughly 250-500 KB for a
// lane this long), which is exactly why this geometry is never sent whole
// on tracking.service.js's 10s board poll -- see BOARD_TOLERANCE_MI there
// and simplify.js's simplifyPath() for the lightweight copy that poll
// actually carries. This function's OWN job stays "get the accurate
// geometry" -- the accuracy/payload tradeoff is made once, downstream, not
// here.
export async function fetchRoutes(origin, destination) {
  const url = `${OSRM_BASE_URL}/route/v1/driving/`
    + `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
    + '?overview=full&geometries=geojson&alternatives=true&steps=true'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let response
  try {
    response = await fetch(url, { signal: controller.signal })
  } catch (err) {
    // Network failure or our own AbortController firing -- either way
    // OSRM did not answer. err.message is safe to surface (no key, no
    // request body -- this endpoint takes no credentials at all).
    throw new AppError('ROUTE_UNAVAILABLE', err.message)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new AppError('ROUTE_UNAVAILABLE', `OSRM HTTP ${response.status}`)
  }

  const data = await response.json()

  // OSRM answers 200 OK even when it could not route -- the real result is
  // in the body's own `code` field ('NoRoute', 'InvalidQuery', etc). Never
  // returning an empty array here on a non-'Ok' code: an empty array reads
  // as "route fetched, nothing found on it", which is a different claim
  // than "the router refused this request".
  if (data.code !== 'Ok') {
    throw new AppError('ROUTE_UNAVAILABLE', `OSRM: ${data.code}${data.message ? ` -- ${data.message}` : ''}`)
  }

  return (data.routes ?? []).slice(0, MAX_ALTERNATIVES).map((route) => ({
    geometry: route.geometry.coordinates,
    distanceMi: Math.round(route.distance / METERS_PER_MILE),
    durationMin: Math.round(route.duration / 60),
    roadRefs: extractRoadRefs(route),
  }))
}

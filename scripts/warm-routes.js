// Pre-fetches real road routes for every lane the company's own loads
// already run, so the tracking board's markers are road-accurate the
// first time a dispatcher opens it instead of the first time someone
// happens to GET /tracking/route for that exact lane.
//
//   node scripts/warm-routes.js
//   node scripts/warm-routes.js --limit=20
//   node scripts/warm-routes.js --refresh
//
// Read-only against `loads`; writes only land in lane_routes, and only
// through routing.service.js's own cache-then-fetch path -- a lane
// already cached here costs nothing (routesFor() returns without ever
// calling OSRM).
//
// --refresh: re-fetches and OVERWRITES every lane, including ones already
// cached, through routing.service.js's refreshRoutes() (OSRM every time,
// UPSERT not INSERT). Exists for exactly one migration: rows written
// while osrm.js requested overview=simplified carry the coarse geometry
// that cuts across fields at city zoom (see osrm.js's own header and
// tracking.service.js's BOARD_TOLERANCE_MI) -- those rows are now stale
// and this is the one place that replaces them. Without --refresh (the
// default), an already-cached lane is left exactly as it is, same as
// before this flag existed.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { routesFor, refreshRoutes } from '../src/modules/routing/routing.service.js'

// router.project-osrm.org is a shared community demo instance, not a
// service this project pays for or has any agreement with -- see
// osrm.js's own header. It publishes no rate limit, so there is no
// documented number to cite; 1 request/second is the de facto courtesy
// norm for a free public routing/geocoding demo (the same order as
// OpenStreetMap's Nominatim, which DOES publish "no more than 1 req/s" for
// its own public instance), and this script pauses that long between
// LANES -- not between the up-to-3 alternatives of one lane, which OSRM
// answers as a single request regardless of how many routes come back.
const PAUSE_BETWEEN_LANES_MS = 1000

function parseLimit(argv) {
  const flag = argv.find((a) => a.startsWith('--limit='))
  if (!flag) return null
  const n = Number(flag.slice('--limit='.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseRefresh(argv) {
  return argv.includes('--refresh')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Every distinct lane the company's own loads have actually run --
// booked, dispatched or delivered, it doesn't matter which; a lane that
// existed once can exist again. DISTINCT so a lane with fifty loads on it
// is warmed once, not fifty times.
async function distinctLoadLanes() {
  const result = await pool.query(`
    SELECT DISTINCT origin_city AS "originCity", origin_state AS "originState",
           destination_city AS "destinationCity", destination_state AS "destinationState"
      FROM loads
     ORDER BY 1, 2, 3, 4`)
  return result.rows
}

async function main() {
  const argv = process.argv.slice(2)
  const limit = parseLimit(argv)
  const refresh = parseRefresh(argv)
  const allLanes = await distinctLoadLanes()
  const lanes = limit ? allLanes.slice(0, limit) : allLanes

  console.log(
    `${allLanes.length} distinct lane(s) in loads`
    + `${limit ? `, --limit=${limit} applied (${lanes.length} to run)` : ''}`
    + `${refresh ? ', --refresh applied (every lane re-fetched from OSRM)' : ''}.`,
  )

  let fetched = 0
  let cached = 0
  let refreshed = 0
  let failed = 0
  const failures = []

  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i]
    const origin = { city: lane.originCity, state: lane.originState }
    const destination = { city: lane.destinationCity, state: lane.destinationState }
    const label = `${lane.originCity}, ${lane.originState} -> ${lane.destinationCity}, ${lane.destinationState}`

    // A cache check BEFORE calling routesFor would be a second copy of the
    // "is it cached" decision routing.service.js already makes -- instead,
    // ask the pool directly here just to decide whether this iteration
    // owes OSRM a pause, so a fully-warm re-run finishes in seconds
    // instead of (lane count) seconds for no reason.
    // eslint-disable-next-line no-await-in-loop
    const before = await pool.query(
      `SELECT 1 FROM lane_routes
        WHERE origin_city = $1 AND origin_state = $2
          AND destination_city = $3 AND destination_state = $4
        LIMIT 1`,
      [origin.city, origin.state, destination.city, destination.state],
    )
    const wasCached = before.rowCount > 0

    try {
      if (refresh) {
        // --refresh: ALWAYS hits OSRM and overwrites, cached or not --
        // see refreshRoutes()'s own header. `wasCached` is still used
        // below only to label the log line with what this lane's state
        // was BEFORE this run, not to decide whether to fetch.
        // eslint-disable-next-line no-await-in-loop
        await refreshRoutes(origin, destination)
        refreshed += 1
        console.log(`  refreshed ${label}${wasCached ? ' (was cached)' : ' (new)'}`)
      } else {
        // eslint-disable-next-line no-await-in-loop
        await routesFor(origin, destination)
        if (wasCached) {
          cached += 1
          console.log(`  cached   ${label}`)
        } else {
          fetched += 1
          console.log(`  fetched  ${label}`)
        }
      }
    } catch (err) {
      failed += 1
      failures.push({ lane: label, message: err.message })
      console.error(`  FAILED   ${label}: ${err.message}`)
    }

    // Only pause after a lane that actually hit OSRM -- an already-cached
    // lane cost the network nothing and owes it no wait. --refresh ALWAYS
    // hits OSRM (that is the entire point of the flag), so it always owes
    // the pause, regardless of what wasCached says.
    const isLast = i === lanes.length - 1
    if ((refresh || !wasCached) && !isLast) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(PAUSE_BETWEEN_LANES_MS)
    }
  }

  console.log('')
  console.log(
    refresh
      ? `${lanes.length} lane(s) processed: ${refreshed} refreshed, ${failed} failed.`
      : `${lanes.length} lane(s) processed: ${fetched} fetched, ${cached} already cached, ${failed} failed.`,
  )
  if (failures.length > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f.lane}: ${f.message}`)
  }

  await pool.end()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('warm-routes aborted:', err.message)
  process.exit(1)
})

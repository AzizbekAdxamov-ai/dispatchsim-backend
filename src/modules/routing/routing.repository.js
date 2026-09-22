// Data access for lane_routes. This is the ONLY file that writes SQL
// against that table -- routing.service.js calls getRoutes()/saveRoutes(),
// never the pool directly (mirrors the rule at the top of
// userRoles.repository.js).

import { query } from '../../db/pool.js'
import * as SQL from './routing.sql.js'

// lane: { origin: { city, state }, destination: { city, state } }.
// Every cached alternative for this exact lane, ordered 0, 1, 2 -- the
// same order routing.service.js hands back whether it came from here or
// straight off OSRM.
export async function getRoutes(lane) {
  const result = await query(SQL.GET_ROUTES_SQL, [
    lane.origin.city, lane.origin.state,
    lane.destination.city, lane.destination.state,
  ])
  return result.rows
}

// Takes a checked-out client (routing.service.js runs this inside
// withTransaction) rather than the shared pool: writing three alternatives
// as three separate un-transacted INSERTs would let a crash between them
// leave a lane with only its first route cached, which reads back later
// as "OSRM only ever had one alternative for this" -- a fact that isn't
// true.
//
// `routes` is an ARRAY in rank order (position.js/osrm.js's own routes[]
// order) -- its index IS alternative_index, not a field the caller has to
// carry separately.
export async function saveRoutes(client, lane, routes) {
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i]
    // eslint-disable-next-line no-await-in-loop -- each row depends on the
    // one before only in that they share a transaction; there is nothing
    // to parallelize a handful of INSERTs against inside one connection.
    await client.query(SQL.INSERT_ROUTE_SQL, [
      lane.origin.city, lane.origin.state,
      lane.destination.city, lane.destination.state,
      i,
      JSON.stringify(route.geometry),
      route.distanceMi,
      route.durationMin,
      route.roadRefs,
    ])
  }
}

// Same shape/contract as saveRoutes() (one transaction, index IS
// alternative_index), but OVERWRITES a row that is already there instead
// of leaving it -- see UPSERT_ROUTE_SQL's own header. ONLY
// routing.service.js's refreshRoutes() calls this; saveRoutes() (used by
// the live routesFor() cache-read-through path) is untouched.
export async function saveRoutesForce(client, lane, routes) {
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i]
    // eslint-disable-next-line no-await-in-loop -- same reasoning as
    // saveRoutes() above: one transaction, nothing here to parallelize.
    await client.query(SQL.UPSERT_ROUTE_SQL, [
      lane.origin.city, lane.origin.state,
      lane.destination.city, lane.destination.state,
      i,
      JSON.stringify(route.geometry),
      route.distanceMi,
      route.durationMin,
      route.roadRefs,
    ])
  }
}

// Every cached route, every lane, every alternative -- see
// LIST_ALL_ROUTES_SQL's own header for who reads this and why it's
// separate from getRoutes().
export async function listAllRoutes() {
  const result = await query(SQL.LIST_ALL_ROUTES_SQL)
  return result.rows
}

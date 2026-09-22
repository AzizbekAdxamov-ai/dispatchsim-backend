// Data access for `facilities` (migration 035). This is the ONLY file
// that writes SQL against that table -- the same "one file owns one
// table's SQL" rule as routing.repository.js/userRoles.repository.js.

import { query } from '../../db/pool.js'
import * as SQL from './facilities.sql.js'

// kinds: string[] of 'fuel'|'truck_stop'|'rest_area'|'repair', or
// null/undefined for "any kind" -- SQL sees `$3::text[] IS NULL OR ...`,
// so passing null is what "no filter" means to the query, not an empty
// array (an empty array would match NOTHING, which is a different
// question -- "kinds=" on the wire vs "kinds" left off entirely).
export async function listNear(lat, lon, radiusMi, kinds) {
  const result = await query(SQL.LIST_NEAR_SQL, [lat, lon, kinds ?? null, radiusMi])
  return result.rows
}

export async function nearestTo(lat, lon, kinds) {
  const result = await query(SQL.NEAREST_ONE_SQL, [lat, lon, kinds ?? null])
  return result.rows[0] ?? null
}

export async function listAll() {
  const result = await query(SQL.LIST_ALL_SQL)
  return result.rows
}

// Takes a checked-out client, like routing.repository.js's saveRoutes --
// scripts/generate-facilities.js runs a whole route's worth of inserts
// inside one transaction, for the same reason saveRoutes does: a crash
// between rows should not leave a corridor half-stocked and reading back
// as "this is all there is here" when it isn't.
//
// Returns how many rows were ACTUALLY inserted (ON CONFLICT DO NOTHING
// means some rows may already exist), so the caller can report a true
// "X new, Y already there" instead of just "ran N inserts".
export async function insertMany(client, rows) {
  let inserted = 0
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- see saveRoutes' own
    // comment: these rows only need to share a transaction, not run in
    // parallel, and a handful-to-low-hundreds of INSERTs is not where
    // this script's time goes.
    const result = await client.query(SQL.INSERT_FACILITY_SQL, [
      row.id, row.kind, row.name, row.lat, row.lon,
      row.nearCity, row.nearState, row.fuelPriceCents ?? null, row.amenities ?? [],
    ])
    if (result.rows.length > 0) inserted += 1
  }
  return inserted
}

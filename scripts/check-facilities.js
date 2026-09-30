// Which facilities sit in the WATER?
//
// Read-only: SELECTs every facility row and asks the same land mask the
// generator now builds against (scripts/seed/facilities.js's isOnLand,
// fed by the frontend's generated NATION_RINGS). Prints the wet ones and
// exits non-zero when any exist, so a CI or a careful human gets a
// yes/no instead of a screenshot.
//
//   node scripts/check-facilities.js            # list them
//   node scripts/check-facilities.js --quiet    # count only
//
// Fixing them is NOT this script's job: the generator now refuses water
// points, so deleting the wet rows and re-running
// `node scripts/generate-facilities.js` regenerates them on land. Rows
// referenced by stop_visits must be MOVED, not deleted (035's own
// promise: a facility is never deleted while a visit remembers it) --
// that case is reported separately and left to a human.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { isOnLand } from '../scripts/seed/facilities.js'

const quiet = process.argv.includes('--quiet')

const { rows } = await pool.query(
  'SELECT id, name, near_city AS "nearCity", near_state AS "nearState", lat, lon FROM facilities ORDER BY id',
)

const wet = rows.filter((f) => !isOnLand(Number(f.lat), Number(f.lon)))

if (wet.length === 0) {
  console.log(`${rows.length} facility(ies) checked, all on land.`)
  await pool.end()
  process.exit(0)
}

const referenced = new Set(
  (await pool.query('SELECT DISTINCT facility_id FROM stop_visits')).rows.map((r) => r.facility_id),
)

const movable = wet.filter((f) => !referenced.has(f.id))
const blocked = wet.filter((f) => referenced.has(f.id))

console.log(`${rows.length} facility(ies) checked, ${wet.length} in water:`)
if (!quiet) {
  for (const f of movable) {
    console.log(`  wet (deletable, unreferenced)  ${f.id}  ${f.name} — ${f.nearCity}, ${f.nearState}  (${f.lat}, ${f.lon})`)
  }
  for (const f of blocked) {
    console.log(`  wet (REFERENCED by stop_visits — move by hand)  ${f.id}  ${f.name} — ${f.nearCity}, ${f.nearState}  (${f.lat}, ${f.lon})`)
  }
}
console.log(`\n${movable.length} deletable, ${blocked.length} referenced. ` +
  'Regenerate with: node scripts/generate-facilities.js')

await pool.end()
process.exit(movable.length > 0 ? 1 : 0)

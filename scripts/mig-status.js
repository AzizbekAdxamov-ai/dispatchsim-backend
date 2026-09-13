// Which migrations the database thinks it has, and whether the columns
// they add are actually there.
//
// Exists because a migration file EDITED AFTER IT WAS APPLIED does not
// re-run: the runner records filenames, not content. The file then says
// one thing and the schema says another, and the only symptom is a query
// failing on a column that is right there in the .sql.
import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const applied = await pool.query(
  'SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 8',
)
console.log("Qo'llangan (oxirgi 8):")
for (const r of applied.rows) console.log('  ', r.version, '—', r.applied_at.toISOString())

const columns = [
  ['loads', 'event_checked_at'],
  ['loads', 'promised_eta_at'],
  ['driver_messages', 'kind'],
  ['driver_settlements', 'paid_at'],
  ['load_events', 'place'],
]
console.log('\nUstunlar:')
for (const [table, column] of columns) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  )
  console.log(`  ${r.rowCount ? 'bor  ' : 'YO\'Q '} ${table}.${column}`)
}
await pool.end()

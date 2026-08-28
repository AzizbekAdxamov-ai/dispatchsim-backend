// Seed runner. Mirrors migrate.js's shape (read the directory, run every
// *.sql file in filename order) but for src/db/seeds/ instead of
// src/db/migrations/, and as ONE transaction across every file instead of
// migrate.js's one-transaction-per-file: a seed file is not a migration,
// and if a second seed file ever failed, the first must not have already
// committed its own TRUNCATE and left the database half-seeded.
//
// Every generated seed file already wraps itself in its own BEGIN;/COMMIT;
// (see scripts/seed/render.js's renderSeedFile -- fixed, not edited here).
// Naively wrapping ANOTHER BEGIN/COMMIT around client.query(fileText) would
// nest a transaction: the file's own inner COMMIT would fire first and
// commit everything read so far, defeating the "one transaction across
// every file" goal the moment a second seed file existed. So each file's
// BEGIN;/COMMIT; lines are stripped before concatenating, and this file
// owns the single outer transaction instead.
//
// Refuses outright when NODE_ENV=production: every seed file TRUNCATEs
// real tables, which is never something to run against a production
// database by accident.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SEEDS_DIR = path.join(__dirname, 'seeds')

async function getSeedFiles() {
  const entries = await readdir(SEEDS_DIR)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

// Removes only stand-alone `BEGIN;` / `COMMIT;` lines (renderSeedFile's own
// wrapper), leaving every comment and statement in the file untouched.
function stripTransactionWrapper(sql) {
  return sql
    .split('\n')
    .filter((line) => line.trim() !== 'BEGIN;' && line.trim() !== 'COMMIT;')
    .join('\n')
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. Seed files TRUNCATE real tables.')
    process.exitCode = 1
    return
  }

  const files = await getSeedFiles()
  if (files.length === 0) {
    console.log('No seed files in src/db/seeds/. Run npm run generate:seed first.')
    await pool.end()
    return
  }

  const bodies = []
  for (const file of files) {
    const raw = await readFile(path.join(SEEDS_DIR, file), 'utf8')
    bodies.push(`-- ${file}\n${stripTransactionWrapper(raw)}`)
  }
  const combinedSql = bodies.join('\n\n')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(combinedSql)
    await client.query('COMMIT')
    for (const file of files) console.log(`-> applied ${file}`)
    console.log('Seed complete.')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(`Seeding failed, rolled back: ${err.message}`)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()

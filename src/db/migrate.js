// Migration runner.
//
// Applies every *.sql file in src/db/migrations/ that has not yet been
// recorded in the schema_migrations table, in filename order. Each
// migration runs inside its own transaction: on failure the transaction is
// rolled back and the process exits non-zero so a partially-applied
// migration never gets silently recorded as done.

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      -- sha256 of the file as it was when it ran. NULL for rows written
      -- before this existed; see warnOnEditedMigrations.
      checksum text NULL
    )
  `)
}

// Databases migrated before checksums existed have the table without the
// column. Added here rather than in a migration because the migration
// runner has to be able to read it before it can run any migration.
async function ensureChecksumColumn() {
  await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text NULL')
}

async function getAppliedVersions() {
  const result = await pool.query('SELECT version, checksum FROM schema_migrations')
  return new Map(result.rows.map((row) => [row.version, row.checksum]))
}

function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16)
}

// Warn when an ALREADY-APPLIED migration's file has changed.
//
// The runner records filenames, so editing an applied migration changes
// the file and nothing else: the .sql claims a column the schema does not
// have, and the only symptom is a query failing on something that is
// plainly there in the source. That cost an hour on 2026-09-10 --
// event_checked_at was added to 027 after 027 had run, and the first sign
// was sql:check reporting a column as missing.
//
// A warning rather than an error: rows applied before checksums existed
// have none, and a comment-only edit is harmless. What matters is that the
// next person changing an applied file is TOLD, instead of finding out
// from a failure three steps later.
async function warnOnEditedMigrations(applied, files) {
  const edited = []
  for (const fileName of files) {
    if (!applied.has(fileName)) continue
    const recorded = applied.get(fileName)
    if (!recorded) continue
    // eslint-disable-next-line no-await-in-loop
    const sql = await readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8')
    if (checksumOf(sql) !== recorded) edited.push(fileName)
  }
  if (edited.length === 0) return

  console.warn('')
  console.warn('OGOHLANTIRISH: quyidagi migratsiyalar QOLLANGANDAN KEYIN ozgargan:')
  for (const f of edited) console.warn(`  - ${f}`)
  console.warn('')
  console.warn('  Ular qayta ishga tushmaydi. Fayldagi ozgarish bazaga yetmagan.')
  console.warn('  Ozgarishni YANGI migratsiya fayliga kochiring.')
  console.warn('')
}

async function getMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

async function applyMigration(fileName) {
  const filePath = path.join(MIGRATIONS_DIR, fileName)
  const sql = await readFile(filePath, 'utf8')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [fileName, checksumOf(sql)],
    )
    await client.query('COMMIT')
    console.log(`→ applied ${fileName}`)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(`Failed to apply migration ${fileName}: ${err.message}`)
    throw err
  } finally {
    client.release()
  }
}

async function main() {
  try {
    await ensureMigrationsTable()
    await ensureChecksumColumn()
    const [files, applied] = await Promise.all([getMigrationFiles(), getAppliedVersions()])

    // Before anything runs. An edited-but-applied migration is not a
    // reason to stop, but it IS the reason a later query will fail on a
    // column the file plainly declares, and the person running this is the
    // one who can still do something about it.
    await warnOnEditedMigrations(applied, files)

    const pending = files.filter((file) => !applied.has(file))

    if (pending.length === 0) {
      console.log('No new migrations.')
    } else {
      for (const file of pending) {
        await applyMigration(file)
      }
    }
  } catch (err) {
    console.error('Migration run aborted.')
    await pool.end()
    process.exit(1)
  }

  await pool.end()
}

main()

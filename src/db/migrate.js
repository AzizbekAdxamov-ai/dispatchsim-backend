// Migration runner.
//
// Applies every *.sql file in src/db/migrations/ that has not yet been
// recorded in the schema_migrations table, in filename order. Each
// migration runs inside its own transaction: on failure the transaction is
// rolled back and the process exits non-zero so a partially-applied
// migration never gets silently recorded as done.

import { readdir, readFile } from 'node:fs/promises'
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
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function getAppliedVersions() {
  const result = await pool.query('SELECT version FROM schema_migrations')
  return new Set(result.rows.map((row) => row.version))
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
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [fileName])
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
    const [files, applied] = await Promise.all([getMigrationFiles(), getAppliedVersions()])
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

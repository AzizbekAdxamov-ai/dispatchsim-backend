// Every loads.status literal in the SQL is a status the schema allows.
//
// alerts.sql.js's HOS_LOW_DRIVERS_SQL once filtered on l.status =
// 'in-transit' -- not one of 007's loads_status_valid values -- so the
// "drive time almost out" alert could never fire, and sql-check could not
// notice: comparing a column to an impossible string is valid SQL. This
// reads the allowed set out of the migration itself and checks every
// l.status literal in every file where `l` is the loads table.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')

function allowedStatuses() {
  // The LATEST migration that (re)defines the constraint wins -- 072 added
  // 'cancelled' to the set 007 created.
  const dir = join(srcDir, 'db', 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const pattern = /loads_status_valid\s+CHECK\s*\(status IN \(([^)]+)\)\)/
  let m = null
  for (const f of files) {
    const hit = readFileSync(join(dir, f), 'utf8').match(pattern)
    if (hit) m = hit
  }
  assert.ok(m, 'loads_status_valid CHECK not found in any migration')
  return new Set(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')))
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'migrations' ? [] : jsFiles(p)
    return name.endsWith('.js') ? [p] : []
  })
}

test('every l.status literal on the loads table is an allowed status', () => {
  const allowed = allowedStatuses()
  const bad = []
  let checked = 0
  for (const file of jsFiles(srcDir)) {
    const src = readFileSync(file, 'utf8')
    if (!/\b(FROM|JOIN)\s+loads\s+l\b/.test(src)) continue
    for (const m of src.matchAll(/l\.status\s*(?:=|<>|!=|IN|NOT IN)\s*\(?([^)\n]*)/g)) {
      for (const lit of m[1].matchAll(/'([^']*)'/g)) {
        checked += 1
        if (!allowed.has(lit[1])) bad.push(`${file.slice(srcDir.length + 1)}: '${lit[1]}'`)
      }
    }
  }
  assert.ok(checked >= 10, `only ${checked} literals found -- the scan stopped matching`)
  assert.deepEqual(bad, [])
})

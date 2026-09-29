// Does reset-company.js know about every table in the schema?
//
// Migration 025 shipped driver_settlements with ON DELETE RESTRICT and
// `npm run reset:company` stopped working. Not loudly -- it refused to
// delete drivers because a settlement row was holding them, and the error
// named a constraint, not the reason. Migration 028 changed the foreign
// key and reset started working again. reset-company.js itself was never
// touched, in either direction: it was broken by a file it does not
// import and fixed by another one.
//
// That is the failure this test exists to make impossible. Not "does the
// reset delete everything" -- that needs a database. This asks a smaller
// question that needs nothing: has a human decided, for every table that
// exists, whether the company owns it? Three answers are allowed, and a
// table with no answer fails here, in `npm test`, on the day it is added.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { KEEP, INFRASTRUCTURE, COMPANY_ROOTS, unknownTables } from '../src/db/companyTables.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'src', 'db', 'migrations')

// The WIPE list lives in a script that connects to a database and wipes it
// on import. It cannot be imported, so it is read as text. Parsing source
// is a poor way to learn a fact and a good way to learn it is missing:
// the regex matches the first string of each WIPE entry, and the assertion
// below on the count is what notices if the shape of that list changes and
// this stops finding anything.
// Two WIPE lists exist now. reset-company.js keeps its own inline --
// nothing else needs it. fresh-start.js keeps its statements in
// src/db/freshStart.sql.js so sql-check.js can PREPARE them, which is
// also why one of these paths does not end in scripts/.
const WIPE_SOURCES = [
  ['reset-company.js', ['scripts', 'reset-company.js']],
  ['freshStart.sql.js', ['src', 'db', 'freshStart.sql.js']],
]

function wipeList(parts = ['scripts', 'reset-company.js']) {
  const src = readFileSync(join(here, '..', ...parts), 'utf8')
  const block = src.match(/const WIPE = \[([\s\S]*?)\n\]/)
  assert.ok(block, `WIPE ro'yxati ${parts.join('/')} ichida topilmadi`)
  return [...block[1].matchAll(/\['([a-z_]+)',/g)].map((m) => m[1])
}

function tablesInMigrations() {
  const names = new Set()
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/gi)) {
      names.add(m[1])
    }
  }
  return names
}

test('every table in the schema is classified exactly once', () => {
  const wiped = new Set(wipeList())
  const tables = tablesInMigrations()

  // schema_migrations is created by migrate.js, not by a migration file,
  // so it never appears in the scan. It is classified anyway.
  assert.ok(tables.size >= 20, `migratsiyalarda ${tables.size} ta jadval topildi -- juda kam`)

  const unclassified = []
  const doubled = []
  for (const t of tables) {
    const votes = [wiped.has(t), KEEP.has(t), INFRASTRUCTURE.has(t)].filter(Boolean).length
    if (votes === 0) unclassified.push(t)
    if (votes > 1) doubled.push(t)
  }

  assert.deepEqual(unclassified, [],
    `bu jadvallar hech qayerda e'lon qilinmagan -- reset ularni bilmaydi: ${unclassified.join(', ')}`)
  assert.deepEqual(doubled, [],
    `bu jadvallar bir vaqtda ham o'chiriladi ham saqlanadi: ${doubled.join(', ')}`)
})

for (const [label, parts] of WIPE_SOURCES) test(`${label} deletes children before their parents`, () => {
  const order = wipeList(parts)
  const pos = new Map(order.map((t, i) => [t, i]))

  // Read the real foreign keys out of the migrations rather than listing
  // them here. A pair listed here would be a second copy of the schema,
  // and the second copy is the one that goes stale.
  //
  // Only ON DELETE CASCADE and RESTRICT matter: a SET NULL parent can be
  // deleted first, which is what RELEASE in the script relies on.
  const edges = []
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    for (const block of sql.split(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?/i).slice(1)) {
      const child = block.match(/^([a-z_]+)/)?.[1]
      if (!child) continue
      for (const m of block.matchAll(/REFERENCES\s+([a-z_]+)\s*\([a-z_]+\)\s*ON DELETE (CASCADE|RESTRICT)/gi)) {
        edges.push([child, m[1]])
      }
    }
  }
  assert.ok(edges.length > 5, `foreign key topilmadi (${edges.length})`)

  const wrong = []
  for (const [child, parent] of edges) {
    if (!pos.has(child) || !pos.has(parent)) continue
    if (pos.get(child) > pos.get(parent)) wrong.push(`${child} -> ${parent}`)
  }
  assert.deepEqual(wrong, [],
    `bola jadval ota-onasidan keyin o'chirilyapti: ${wrong.join(', ')}`)
})

for (const [label, parts] of WIPE_SOURCES) test(`${label} empties every company root`, () => {
  const wiped = new Set(wipeList(parts))
  for (const root of COMPANY_ROOTS) {
    assert.ok(wiped.has(root), `${root} kompaniya ildizi, lekin WIPE ichida yo'q`)
  }
})

// The audit that runs inside both wipe scripts asks the database which
// tables the company can reach, then asks itself which of those it has
// never heard of. For a year it asked that question against KEEP alone.
//
// Migration 046 added telegram_deliveries, 047 telegram_attachments. Both
// hang off driver_messages, so the walk reaches them; both are classified
// as INFRASTRUCTURE, because the cascade off the messages clears them and
// no named DELETE should. Against KEEP alone they read as unclassified,
// and the audit aborted -- rolling back a wipe that had just succeeded --
// with a message telling whoever ran it to add two tables to a list they
// already belonged to another one of.
//
// Delete `!INFRASTRUCTURE.has(t)` from unknownTables and the first
// assertion here fails. Delete `!KEEP.has(t)` and the second does.
// Delete the whole filter and the third does.
test('a table classified as infrastructure is not an unknown table', () => {
  const wiped = new Set(['loads', 'drivers'])

  assert.deepEqual(
    unknownTables(['telegram_deliveries', 'telegram_attachments'], wiped), [],
    'ko\'prikning o\'z jadvallari "noma\'lum" deb o\'qilyapti',
  )
  assert.deepEqual(unknownTables(['load_postings', 'users'], wiped), [],
    'KEEP ro\'yxatidagi jadval "noma\'lum" deb o\'qilyapti')
  assert.deepEqual(unknownTables(['loads', 'drivers'], wiped), [],
    'skript o\'zi o\'chiradigan jadval "noma\'lum" deb o\'qilyapti')
})

test('a table nobody has classified is still reported', () => {
  // The other half of the same function: widening the filter until
  // nothing is ever unknown would pass every assertion above and make the
  // audit useless. This is the table migration 049 has not written yet.
  assert.deepEqual(
    unknownTables(['loads', 'trailer_leases'], new Set(['loads'])),
    ['trailer_leases'],
  )
})

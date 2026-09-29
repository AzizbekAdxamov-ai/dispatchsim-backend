// The company's own identity (048).
//
// Until this row existed the carrier's name was read off `users.company`
// -- free text, typed once per person at registration -- and the MC
// number did not exist anywhere, so the rate confirmation printed a
// sentence saying so where a broker looks for the number that decides
// whether they send you a load.
//
// Each test names the mutation it kills. The schema and the formatting
// need no database; the single-row rule does, and skips without one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { updateCarrierSchema } from '../src/modules/carrier/carrier.schemas.js'
import { addressLine } from '../src/modules/carrier/carrier.repository.js'
import { KEEP } from '../src/db/companyTables.js'

const { hasDb } = await import('./helpers/db.js')
const here = dirname(fileURLToPath(import.meta.url))
const migration = readFileSync(join(here, '../src/db/migrations/048_carrier.sql'), 'utf8')

// Kills: loosening the MC or DOT format. A broker checks that number;
// one that cannot be checked is worse than an empty field, because it
// looks like an answer.
test('the authority numbers keep their shape', () => {
  assert.doesNotThrow(() => updateCarrierSchema.parse({ mcNumber: 'MC-741309' }))
  for (const bad of ['741309', 'MC741309', 'MC-74130', 'MC-7413099', 'mc-741309']) {
    assert.throws(() => updateCarrierSchema.parse({ mcNumber: bad }), undefined, bad)
  }
  assert.doesNotThrow(() => updateCarrierSchema.parse({ dotNumber: '3947182' }))
  assert.throws(() => updateCarrierSchema.parse({ dotNumber: '39471' }))
  assert.throws(() => updateCarrierSchema.parse({ dotNumber: '39a7182' }))
})

// Kills: the schema drifting away from the CHECK in 048. The database is
// the wall; the schema exists to explain it first, and a schema that
// accepts what the wall refuses turns a sentence into a 500.
test('the schema and the migration agree on the formats', () => {
  assert.match(migration, /carrier_mc_fmt\s+CHECK \(mc_number ~ '\^MC-\[0-9\]\{6\}\$'\)/)
  assert.match(migration, /carrier_dot_fmt\s+CHECK \(dot_number ~ '\^\[0-9\]\{6,8\}\$'\)/)
  assert.match(migration, /carrier_zip_fmt\s+CHECK \(postal_code ~ '\^\[0-9\]\{5\}\$'\)/)
})

// Kills: accepting an empty PATCH, which would bump updated_at and tell
// the caller something changed when nothing did.
test('a change with nothing in it is refused', () => {
  assert.throws(() => updateCarrierSchema.parse({}))
  assert.throws(() => updateCarrierSchema.parse({ nickname: 'Keystone' }))
})

// Kills: one address format on the rate confirmation and another on the
// invoice. One company, one way of writing where it is.
test('the address reads the same everywhere', () => {
  assert.equal(
    addressLine({ addressLine: '4120 Empire Central Drive', city: 'Dallas', state: 'TX', postalCode: '75247' }),
    '4120 Empire Central Drive, Dallas, TX 75247',
  )
  assert.equal(addressLine(null), '')
})

// Kills: a reset that wipes the company's own name. reset-company.js
// clears what the company has DONE -- loads, trucks, money -- not who it
// is. Without this the next rate confirmation goes out unsigned.
test('a company reset does not take the company name with it', () => {
  assert.ok(KEEP.has('carrier'), 'carrier belongs to the KEEP list')
})

// Kills: a second carrier row. The whole program is one company in one
// database; two rows means two names on two documents and no way to say
// which is the company.
// ONE deliberate failure per transaction, and each in its own.
//
// PostgreSQL aborts the whole transaction on the first error: everything
// after it comes back as "current transaction is aborted" instead of the
// constraint you were trying to prove. dvirFlow.test.js already says this
// in a comment -- "each lie has its own transaction" -- and this file was
// written with two lies in one, which is exactly how it failed.
test('there can only ever be one carrier', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    const existing = await client.query('SELECT count(*)::int AS n FROM carrier')
    assert.equal(existing.rows[0].n, 1, '048 seeds exactly one row')

    await assert.rejects(
      () => client.query(
        `INSERT INTO carrier (id, name, mc_number, dot_number, phone, address_line, city, state, postal_code)
         VALUES (true, 'Second Carrier', 'MC-000001', '1234567', '555-0100', '1 Road', 'Dallas', 'TX', '75247')`,
      ),
      /duplicate key|carrier_pkey/,
      'the primary key is what stops a second company appearing',
    )
  })
})

// Kills: an MC number that is only checked by the app. The schema
// explains the format first; this is the wall behind it, and a patch that
// reaches the database with a broken number has to bounce off the table
// itself.
test('the authority number cannot be broken through the back door', { skip: !hasDb }, async () => {
  const { pool } = await import('../src/db/pool.js')
  const { inRollback } = await import('./helpers/rollback.js')

  await inRollback(pool, async (client) => {
    await assert.rejects(
      () => client.query(`UPDATE carrier SET mc_number = 'MC-12345'`),
      /carrier_mc_fmt/,
    )
  })
})

// Kills: seeding a carrier that would fail its own CHECKs -- a migration
// that cannot run is found here rather than on a fresh database.
test('the seeded company satisfies every rule it sets', () => {
  // Whitespace flattened first: the INSERT is wrapped across lines, and
  // a test that only matches the one-line spelling passes the day
  // somebody reformats the migration.
  const flat = migration.replace(/\s+/g, ' ')
  const values = /VALUES \(true, '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/
    .exec(flat)
  assert.ok(values, 'the migration seeds a row')
  const [, name, mc, dot, , , , state, zip] = values
  assert.ok(name.length >= 3 && name.length <= 160)
  assert.match(mc, /^MC-[0-9]{6}$/)
  assert.match(dot, /^[0-9]{6,8}$/)
  assert.match(state, /^[A-Z]{2}$/)
  assert.match(zip, /^[0-9]{5}$/)
})

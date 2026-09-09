// Full company reset: wipe everything the company built, hand it $200,000,
// and leave the marketplaces alone.
//
//   node scripts/reset-company.js              # dry run, shows counts
//   node scripts/reset-company.js --confirm    # actually does it
//
// This is NOT clear-fleet.js. That script deliberately preserves
// HR-hired drivers and board-booked loads, because it was written to
// remove *seed* data from a running company. This one removes the
// company: every driver however they arrived, every truck, every load,
// every conversation. What survives is the world outside the company --
// the load board, the applicant market, the truck market, the brokers,
// and the user accounts.
//
// Deleting and re-opening the account is the point: cash only means
// something if it starts from a known number, and $200,000 with three
// trucks already parked outside would be a lie about where the money went.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { OPENING_BALANCE_USD } from '../src/constants/simClock.js'

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const host = new URL(DB_URL).hostname
if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
  console.error(`refuses to reset ${host} without --allow-remote`)
  process.exit(1)
}

const CONFIRM = process.argv.includes('--confirm')

// Order matters: children before parents, so no FK has to be deferred.
// broker_conversations cascades from load_postings, but the postings
// themselves stay -- so the conversations are deleted explicitly.
const WIPE = [
  ['broker_messages',      'DELETE FROM broker_messages'],
  ['broker_conversations', 'DELETE FROM broker_conversations'],
  ['broker_checks',        'DELETE FROM broker_checks'],
  ['maintenance_records',  'DELETE FROM maintenance_records'],
  ['truck_daily_metrics',  'DELETE FROM truck_daily_metrics'],
  ['loads',                'DELETE FROM loads'],
  ['trucks',               'DELETE FROM trucks'],
  ['drivers',              'DELETE FROM drivers'],
  ['cash_ledger',          'DELETE FROM cash_ledger'],
]

// Marketplace rows that pointed at something the company owned have to
// forget it FIRST. Not for tidiness: applicants_hired_clean says
// `(status='hired') = (hired_driver_id IS NOT NULL AND hired_at IS NOT
// NULL)`, and the FK is ON DELETE SET NULL -- so deleting a hired driver
// would null the id out from under a row still marked 'hired' and the
// CHECK would reject the delete. Releasing before wiping avoids that
// instead of discovering it as a constraint violation mid-reset.
const RELEASE = [
  ['driver_applicants → open',
   `UPDATE driver_applicants
       SET status = 'open', hired_driver_id = NULL, hired_by_user_id = NULL, hired_at = NULL
     WHERE status = 'hired'`],
  ['truck_listings → open',
   `UPDATE truck_listings
       SET status = 'open', bought_truck_id = NULL, bought_by_user_id = NULL, bought_at = NULL
     WHERE status <> 'open'`],
  ['load_postings → open',
   `UPDATE load_postings SET status = 'open', booked_load_id = NULL, booked_by_user_id = NULL, booked_at = NULL
     WHERE status = 'booked'`],
]

const client = await pool.connect()

try {
  console.log(`\n${CONFIRM ? 'RESET' : 'DRY RUN'} — ${host}\n`)

  // Show what is there before touching anything.
  const before = await client.query(`
    SELECT
      (SELECT count(*) FROM drivers)::int              AS drivers,
      (SELECT count(*) FROM trucks)::int               AS trucks,
      (SELECT count(*) FROM loads)::int                AS loads,
      (SELECT count(*) FROM broker_conversations)::int AS conversations,
      (SELECT count(*) FROM broker_checks)::int        AS checks,
      (SELECT count(*) FROM cash_ledger)::int          AS ledger,
      (SELECT count(*) FROM load_postings WHERE status = 'booked')::int    AS booked_postings,
      (SELECT count(*) FROM driver_applicants WHERE status = 'hired')::int AS hired_applicants,
      (SELECT count(*) FROM truck_listings WHERE status <> 'open')::int    AS sold_listings
  `)
  for (const [k, v] of Object.entries(before.rows[0])) {
    console.log(`  ${k.padEnd(18)} ${v}`)
  }

  if (!CONFIRM) {
    console.log('\n  --confirm bilan ishga tushiring\n')
    process.exit(0)
  }

  await client.query('BEGIN')

  for (const [name, sql] of RELEASE) {
    const r = await client.query(sql)
    console.log(`  released ${name.padEnd(24)} ${r.rowCount}`)
  }
  for (const [name, sql] of WIPE) {
    const r = await client.query(sql)
    console.log(`  wiped    ${name.padEnd(24)} ${r.rowCount}`)
  }

  await client.query(
    `INSERT INTO cash_ledger (kind, amount_usd, description)
     VALUES ('opening', $1, 'Opening balance')`,
    [OPENING_BALANCE_USD],
  )

  await client.query('COMMIT')

  const after = await client.query('SELECT coalesce(sum(amount_usd),0)::int AS balance FROM cash_ledger')
  console.log(`\n  balans: $${after.rows[0].balance.toLocaleString()}\n`)
} catch (err) {
  await client.query('ROLLBACK')
  console.error(`\nreset failed, nothing changed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

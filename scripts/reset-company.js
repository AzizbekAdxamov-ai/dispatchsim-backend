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
import { COMPANY_ROOTS, KEEP, REACHABLE_SQL, quoteIdent } from '../src/db/companyTables.js'

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
//
// Every table here is named even when ON DELETE CASCADE would have carried
// it away. Migration 025 is why: it shipped driver_settlements with
// ON DELETE RESTRICT, and reset stopped working -- not loudly, it just
// refused to delete drivers, because a settlement was holding them. The
// fix was a later migration. Nothing about the reset script had to change,
// which is exactly the problem: reset was correct by accident, and it was
// a foreign key in another file that decided whether it stayed correct.
// A named DELETE is a promise this script makes itself; CASCADE is a
// promise some migration made, possibly years ago, possibly not again.
const WIPE = [
  // Chat: messages before conversations, conversations before the driver.
  ['driver_messages',      'DELETE FROM driver_messages'],
  ['driver_conversations', 'DELETE FROM driver_conversations'],
  ['broker_messages',      'DELETE FROM broker_messages'],
  ['broker_conversations', 'DELETE FROM broker_conversations'],
  ['broker_checks',        'DELETE FROM broker_checks'],

  // Pay and road events: both hang off loads and drivers.
  ['driver_settlements',   'DELETE FROM driver_settlements'],
  ['load_events',          'DELETE FROM load_events'],

  // Acknowledgements. These do NOT cascade -- alert_acks points at users,
  // and the users survive a company reset. Without this line every alert
  // the student ever dismissed stays dismissed for a company that no
  // longer exists: a fresh account, silent about its own first late load.
  ['alert_acks',           'DELETE FROM alert_acks'],

  ['maintenance_records',  'DELETE FROM maintenance_records'],
  ['truck_daily_metrics',  'DELETE FROM truck_daily_metrics'],
  // stop_visits (036): ON DELETE CASCADE off load_id, truck_id AND
  // driver_id all at once -- it has to go before every one of those three
  // parents, not just before loads. facility_id has no ON DELETE clause
  // (a facility is never deleted -- see 036's own comment), so ordering
  // against facilities (KEEP, never wiped) never comes up.
  ['stop_visits',          'DELETE FROM stop_visits'],
  // duty_events (037): CASCADE off driver_id, load_id and truck_id -- same
  // reasoning as stop_visits directly above; facility_id is a plain
  // reference into facilities (KEEP), which is never wiped.
  ['duty_events',          'DELETE FROM duty_events'],
  // driver_qualification (039): the DQ file belongs to the driver it
  // names, so it dies with them on a reset. Named before drivers, like
  // every other child -- though the FK CASCADEs, the named DELETE is
  // this script's own promise, not some migration's old one.
  ['driver_qualification', 'DELETE FROM driver_qualification'],
  // dvir_reports (040): inspection reports name the truck and the load
  // they came from -- both company property, both wiped. CASCADE off
  // truck_id would carry them, but the named DELETE is the promise.
  ['dvir_reports',         'DELETE FROM dvir_reports'],
  // pre_trip_inspections (045): the pre-trip walk-around names the truck
  // and the load it preceded -- both wiped. Reviewed_dvir_id dies with the
  // report it names (SET NULL keeps the inspection row), the inspection
  // row itself dies here, by name, before loads.
  ['pre_trip_inspections', 'DELETE FROM pre_trip_inspections'],
  ['loads',                'DELETE FROM loads'],
  ['trucks',               'DELETE FROM trucks'],
  ['drivers',              'DELETE FROM drivers'],
  ['cash_ledger',          'DELETE FROM cash_ledger'],
]

// The tables above, as a set, for the check that follows the wipe.
const WIPED = new Set(WIPE.map(([name]) => name))

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
      (SELECT count(*) FROM driver_settlements)::int   AS settlements,
      (SELECT count(*) FROM load_events)::int          AS road_events,
      (SELECT count(*) FROM driver_conversations)::int AS driver_chats,
      (SELECT count(*) FROM alert_acks)::int           AS alert_acks,
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

  // Everything above ran. Now ask the database whether it agrees that the
  // company is gone -- before the opening balance is written, so a table
  // still holding rows is caught while the transaction can still be
  // rolled back and while cash_ledger is legitimately empty.
  //
  // Two different failures are looked for, and they are not the same fact:
  //
  //   unknown -- a table hangs off the company but this script has never
  //   heard of it. It may be empty today because CASCADE emptied it. That
  //   is not a reset working; that is a reset that happens not to be
  //   broken yet. It is reported whether or not it holds rows.
  //
  //   survived -- a table this script deleted from, or reached, still has
  //   rows in it after the wipe. Something re-inserted, or a DELETE was
  //   quietly refused.
  const reachable = await client.query(REACHABLE_SQL, [COMPANY_ROOTS])
  const reached = reachable.rows.map((r) => r.table_name)

  const unknown = reached.filter((t) => !WIPED.has(t) && !KEEP.has(t))

  const survived = []
  for (const table of new Set([...WIPED, ...reached])) {
    if (KEEP.has(table)) continue
    const c = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)
    if (c.rows[0].n > 0) survived.push(`${table} (${c.rows[0].n})`)
  }

  if (unknown.length || survived.length) {
    const lines = []
    if (survived.length) lines.push(`  wipe qilingandan keyin ham qator bor: ${survived.join(', ')}`)
    if (unknown.length) {
      lines.push(`  bu jadvallarni reset skripti bilmaydi: ${unknown.join(', ')}`)
      lines.push('  ularni scripts/reset-company.js ichidagi WIPE ro\'yxatiga qo\'shing')
    }
    throw new Error(`reset to\'liq emas\n${lines.join('\n')}`)
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

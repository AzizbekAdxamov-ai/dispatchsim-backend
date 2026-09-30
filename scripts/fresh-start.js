// Fresh start: keep the drivers you name, delete everything else the
// company has, and -- only when asked by name -- delete user accounts.
//
//   node scripts/fresh-start.js                                       # dry run: shows what is there
//   node scripts/fresh-start.js --keep-driver=d4 --confirm
//   node scripts/fresh-start.js --keep-driver=d4 --keep-truck=TX-4821-HX --confirm
//   node scripts/fresh-start.js --keep-driver=d4 --delete-user=test@example.com --confirm
//   node scripts/fresh-start.js --keep-driver=none --confirm          # keep nobody
//
// This is not reset-company.js and not clear-fleet.js.
//
//   clear-fleet.js  removes SEED data and protects what the student built.
//   reset-company.js removes the COMPANY and protects the people (users
//                   are in KEEP: "resetting a company does not un-hire
//                   the student").
//   this script     removes the company EXCEPT the drivers you name, and
//                   will delete user accounts -- but only the exact
//                   addresses passed on the command line. There is no
//                   "delete the test ones" rule in here, because a
//                   script cannot know which account is a test account
//                   and guessing wrong deletes a person.
//
// What a kept driver keeps: who they are. The row, the CDL, the pay
// plan, the DQ file, and where they physically are right now. What they
// lose: everything they have DONE -- loads, settlements, duty events,
// inspections, chats, miles, hours, ratings. Their truck goes with the
// rest of the fleet, so they end up exactly like a driver hired five
// minutes ago: a full 11-hour clock, zero miles, no truck, no history.
//
// --keep-truck changes exactly one thing: the truck named (or, without
// it, the kept driver's own truck) survives the wipe. The truck keeps
// its COLUMNS -- odometer, fuel, tires: facts about the unit -- and
// loses its history like everyone else. A truck cannot be kept for a
// driver who is not: the pairing lives in trucks.driver_id, and this
// script writes no assignments -- that is the app's fleet feature.
//
// --keep-driver is required with --confirm. Not because the default is
// dangerous but because there isn't one: this script cannot tell which
// driver you meant, and the failure mode of guessing is unrecoverable.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { OPENING_BALANCE_USD } from '../src/constants/simClock.js'
import { COMPANY_ROOTS, KEEP, REACHABLE_SQL, quoteIdent, unknownTables } from '../src/db/companyTables.js'
// RELEASE, WIPE and the kept-driver reset live in a module so that
// scripts/sql-check.js can PREPARE them: this file wipes on import and
// cannot be imported by anything.
import { RELEASE, WIPE, RESET_KEPT_DRIVER, paramsFor, resolveTrucksToKeep } from '../src/db/freshStart.sql.js'

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const host = new URL(DB_URL).hostname
if (host !== 'localhost' && host !== '127.0.0.1' && !process.argv.includes('--allow-remote')) {
  console.error(`refuses to touch ${host} without --allow-remote`)
  process.exit(1)
}

const CONFIRM = process.argv.includes('--confirm')

function listArg(flag) {
  const out = []
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith(`${flag}=`)) continue
    for (const part of arg.slice(flag.length + 1).split(',')) {
      const value = part.trim()
      if (value) out.push(value)
    }
  }
  return out
}

const keepArgs = listArg('--keep-driver')
const keepNobody = keepArgs.length === 1 && keepArgs[0].toLowerCase() === 'none'
const KEEP_DRIVERS = keepNobody ? [] : keepArgs
const keepTruckArgs = listArg('--keep-truck')
const DELETE_USERS = listArg('--delete-user').map((e) => e.toLowerCase())

const WIPED = new Set(WIPE.map(([name]) => name))

const client = await pool.connect()

// The body is a function only so that the two early exits above the
// transaction can be plain `return`s: a module's top level cannot return,
// and `process.exit()` there would skip the finally that closes the pool.
async function run() {
  console.log(`\n${CONFIRM ? 'FRESH START' : 'DRY RUN'} — ${host}\n`)

  // Who is in here. Printed before anything is touched, and printed on a
  // dry run instead of a count summary, because the only reason to run
  // this script is to decide which of these rows to name on the command
  // line -- and you cannot name what you have not been shown.
  const users = await client.query(`
    SELECT u.id, u.email, u.name, u.role, u.is_admin,
           to_char(u.created_at, 'YYYY-MM-DD') AS created
      FROM users u
     ORDER BY u.created_at`)

  console.log('  USERS')
  for (const u of users.rows) {
    const marks = [u.is_admin ? 'admin' : ''].filter(Boolean).join(' ')
    console.log(`    ${u.email.padEnd(34)} ${u.name.padEnd(22)} ${u.role.padEnd(14)} ${u.created}  ${marks}`)
  }
  if (users.rowCount === 0) console.log('    (none)')

  const trucks = await client.query(`
    SELECT t.id, t.year, t.make, t.model, t.odometer_mi,
           t.driver_id AS driver
      FROM trucks t
     ORDER BY t.id`)

  const drivers = await client.query(`
    SELECT d.id, d.name, d.duty_status,
           coalesce(d.current_city, d.home_base_city) AS city,
           coalesce(d.current_state, d.home_base_state) AS state,
           d.total_miles,
           to_char(d.created_at, 'YYYY-MM-DD') AS created,
           (SELECT t.id FROM trucks t WHERE t.driver_id = d.id) AS truck,
           (SELECT count(*) FROM loads l WHERE l.driver_id = d.id)::int AS loads
      FROM drivers d
     ORDER BY d.created_at, d.id`)

  console.log('\n  DRIVERS')
  for (const d of drivers.rows) {
    const keeping = KEEP_DRIVERS.includes(d.id) ? '  <-- KEEP' : ''
    console.log(
      `    ${d.id.padEnd(5)} ${d.name.padEnd(22)} ${(d.city + ', ' + d.state).padEnd(20)}` +
      ` ${d.duty_status.padEnd(9)} truck ${String(d.truck ?? '-').padEnd(14)}` +
      ` ${String(d.loads).padStart(3)} loads  ${d.created}${keeping}`,
    )
  }
  if (drivers.rowCount === 0) console.log('    (none)')

  const before = await client.query(`
    SELECT
      (SELECT count(*) FROM trucks)::int               AS trucks,
      (SELECT count(*) FROM loads)::int                AS loads,
      (SELECT count(*) FROM broker_conversations)::int AS broker_chats,
      (SELECT count(*) FROM driver_conversations)::int AS driver_chats,
      (SELECT count(*) FROM cash_ledger)::int          AS ledger,
      (SELECT count(*) FROM driver_settlements)::int   AS settlements,
      (SELECT count(*) FROM load_events)::int          AS road_events,
      (SELECT count(*) FROM duty_events)::int          AS duty_events`)
  console.log('')
  for (const [k, v] of Object.entries(before.rows[0])) {
    console.log(`  ${k.padEnd(14)} ${v}`)
  }

  // Everything that can be wrong with the command line is checked here,
  // together, before the transaction opens -- so a typo costs a re-run
  // and not a half-finished database.
  const driverIds = new Set(drivers.rows.map((d) => d.id))
  const unknownDrivers = KEEP_DRIVERS.filter((id) => !driverIds.has(id))

  const emails = new Map(users.rows.map((u) => [u.email, u]))
  const unknownUsers = DELETE_USERS.filter((e) => !emails.has(e))
  const survivingUsers = users.rows.filter((u) => !DELETE_USERS.includes(u.email))
  const adminsLeft = survivingUsers.filter((u) => u.is_admin).length

  const problems = []
  if (unknownDrivers.length) problems.push(`no such driver: ${unknownDrivers.join(', ')}`)
  if (unknownUsers.length) problems.push(`no such user: ${unknownUsers.join(', ')}`)
  if (CONFIRM && keepArgs.length === 0) {
    problems.push('--keep-driver is required with --confirm (use --keep-driver=none to keep nobody)')
  }
  if (DELETE_USERS.length && survivingUsers.length === 0) {
    problems.push('that would delete every account, including the one you log in with')
  }
  if (DELETE_USERS.length && survivingUsers.length > 0 && adminsLeft === 0) {
    problems.push('that would delete the last admin — nobody could edit the carrier or promote anyone afterwards')
  }

  // Which trucks survive: --keep-truck, or the kept drivers' own trucks.
  // The rules live in freshStart.sql.js as a pure function so the tests
  // can kill their mutations without a database; a refusal (an unknown
  // id, a kept driver stranded without their unit) exits here, before
  // the transaction opens.
  const resolution = resolveTrucksToKeep({
    trucks: trucks.rows,
    drivers: drivers.rows,
    keepDrivers: KEEP_DRIVERS,
    keepTruckArgs,
  })
  if (resolution.error) {
    console.log(`\n  ${resolution.error}\n`)
    process.exitCode = 1
    return
  }
  const KEEP_TRUCKS = resolution.keep

  console.log('\n  TRUCKS')
  for (const t of trucks.rows) {
    const keeping = KEEP_TRUCKS.includes(t.id) ? '  <-- KEEP' : ''
    console.log(
      `    ${t.id.padEnd(14)} ${String(t.year).padEnd(5)} ${`${t.make} ${t.model}`.padEnd(24)} ` +
      `${String(t.odometer_mi).padStart(7)} mi  driver ${String(t.driver ?? 'none').padEnd(5)}${keeping}`,
    )
  }
  if (trucks.rowCount === 0) console.log('    (none)')

  if (problems.length) {
    console.log('')
    for (const p of problems) console.log(`  ${p}`)
    console.log('')
    process.exitCode = 1
    return
  }

  if (!CONFIRM) {
    console.log('\n  Nothing has been changed. To do it:')
    console.log('    node scripts/fresh-start.js --keep-driver=<id> [--keep-truck=<id>] [--delete-user=<email>] --confirm\n')
    return
  }

  await client.query('BEGIN')

  // Every truck-aware statement takes both lists. The rest take the
  // drivers alone, exactly as before.
  for (const [name, sql, kind] of RELEASE) {
    const r = await client.query(sql, paramsFor(kind, KEEP_DRIVERS, KEEP_TRUCKS))
    console.log(`  released ${name.padEnd(26)} ${r.rowCount}`)
  }
  for (const [name, sql, kind] of WIPE) {
    const r = await client.query(sql, paramsFor(kind, KEEP_DRIVERS, KEEP_TRUCKS))
    console.log(`  deleted  ${name.padEnd(26)} ${r.rowCount}`)
  }
  if (KEEP_DRIVERS.length) {
    const r = await client.query(RESET_KEPT_DRIVER, [KEEP_DRIVERS])
    console.log(`  reset    ${'kept drivers'.padEnd(26)} ${r.rowCount}`)
  }
  if (DELETE_USERS.length) {
    // Everything hanging off a user either CASCADEs (roles, alert acks,
    // chat threads) or is SET NULL (who booked
    // a posting, who hired an applicant) -- and the rows that would have
    // been SET NULL were released above anyway. Nothing here needs a
    // hand-written child delete; it needs to run after RELEASE, which it
    // does.
    const r = await client.query('DELETE FROM users WHERE email = ANY($1::text[])', [DELETE_USERS])
    console.log(`  deleted  ${'users'.padEnd(26)} ${r.rowCount}`)
  }

  // Ask the database whether it agrees, while the transaction can still
  // be rolled back. Two different facts are looked for:
  //
  //   unknown  -- a table hangs off the company that this script has
  //   never heard of. It may be empty right now because CASCADE emptied
  //   it, which is not this script working, it is this script not being
  //   broken yet.
  //
  //   survived -- a table still holds rows it should not. The kept
  //   drivers, their DQ files and their trucks are the only rows allowed
  //   to survive, so the number expected is stated rather than assumed.
  const expected = new Map([
    ['drivers', KEEP_DRIVERS.length],
    ['driver_qualification', KEEP_DRIVERS.length],
    ['trucks', KEEP_TRUCKS.length],
  ])

  const reachable = await client.query(REACHABLE_SQL, [COMPANY_ROOTS])
  const reached = reachable.rows.map((r) => r.table_name)
  const unknown = unknownTables(reached, WIPED)

  const survived = []
  for (const table of new Set([...WIPED, ...reached])) {
    if (KEEP.has(table)) continue
    const c = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)
    const allowed = expected.get(table) ?? 0
    if (c.rows[0].n > allowed) survived.push(`${table} (${c.rows[0].n}, expected at most ${allowed})`)
  }

  if (unknown.length || survived.length) {
    const lines = []
    if (survived.length) lines.push(`  rows left after the delete: ${survived.join(', ')}`)
    if (unknown.length) {
      lines.push(`  this script does not know these tables: ${unknown.join(', ')}`)
      lines.push('  add them to the WIPE list in src/db/freshStart.sql.js')
    }
    throw new Error(`fresh start incomplete\n${lines.join('\n')}`)
  }

  await client.query(
    `INSERT INTO cash_ledger (kind, amount_usd, description)
     VALUES ('opening', $1, 'Opening balance')`,
    [OPENING_BALANCE_USD],
  )

  await client.query('COMMIT')

  const after = await client.query(`
    SELECT d.id, d.name, d.duty_status, d.hos_remaining_min, d.total_miles,
           coalesce(d.current_city, d.home_base_city) AS city,
           coalesce(d.current_state, d.home_base_state) AS state
      FROM drivers d ORDER BY d.id`)
  const trucksLeft = await client.query(`
    SELECT t.id, t.odometer_mi, t.driver_id
      FROM trucks t ORDER BY t.id`)
  const balance = await client.query('SELECT coalesce(sum(amount_usd),0)::int AS balance FROM cash_ledger')

  console.log('\n  on the payroll now:')
  for (const d of after.rows) {
    console.log(`    ${d.id}  ${d.name} — ${d.city}, ${d.state}, ${d.duty_status}, ` +
      `${d.hos_remaining_min} min of clock, ${d.total_miles} miles`)
  }
  if (after.rowCount === 0) console.log('    (nobody)')

  console.log('\n  in the yard:')
  for (const t of trucksLeft.rows) {
    console.log(`    ${t.id} — ${t.odometer_mi} mi, driver ${t.driver_id ?? 'none'}`)
  }
  if (trucksLeft.rowCount === 0) console.log('    (no trucks)')

  console.log(`\n  balance: $${balance.rows[0].balance.toLocaleString()}\n`)
}

try {
  await run()
} catch (err) {
  await client.query('ROLLBACK')
  console.error(`\nnothing changed: ${err.message}\n`)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

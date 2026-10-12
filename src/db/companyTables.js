// Which tables belong to the company, and which belong to the world the
// company operates in.
//
// This lives in its own module for one reason: scripts/sql-check.js can
// import it and PREPARE the query below against the real schema.
// reset-company.js cannot be imported -- it connects and wipes on load --
// so a recursive CTE written inside it would be a string nobody parses
// until a student runs a reset and it raises.

// What counts as "the company" at the root. Everything reachable from one
// of these by a chain of foreign keys belongs to the company too, however
// many migrations from now it is added.
export const COMPANY_ROOTS = Object.freeze(['drivers', 'trucks', 'loads', 'cash_ledger'])

// Tables the walk reaches that are NOT the company's to delete. Each one
// is here for a stated reason, so that "not in WIPE" never silently means
// "nobody thought about it".
//
//   load_postings, driver_applicants, truck_listings -- the marketplaces.
//     They are reachable because a booked posting points at the load it
//     became, a hired applicant at the driver it became, a sold listing
//     at the truck. reset-company.js breaks those pointers instead of
//     deleting the rows. The board outlives the company; that is the
//     point of the whole script.
//   users, invite_codes -- the people. Resetting a company does not
//     un-hire the student.
//   brokers -- the world outside. They existed before this company and
//     they will take the next one's calls.
export const KEEP = Object.freeze(new Set([
  'load_postings',
  'driver_applicants',
  'truck_listings',
  'users',
  'invite_codes',
  'brokers',
  // carrier (048) -- who this company IS, as opposed to what it has done.
  // A reset clears the loads, the trucks, the drivers and the money; it
  // does not rename the company or take away its operating authority.
  // Wiping this row would leave a carrier with no name on the next rate
  // confirmation, which is the bug 048 exists to fix.
  'carrier',
  // lane_routes (034) -- a road-geometry cache keyed by city PAIR
  // (origin/destination text columns), not by a foreign key into any
  // company table. The same Dallas -> Houston route is the same route
  // whichever company searches it -- it's world geography, not something
  // this company owns -- so it belongs with brokers/CITIES, not with the
  // drivers/trucks/loads a reset actually clears.
  'lane_routes',
  // chat_turn_log (056) -- the record of how the chat models answered:
  // the prompt, the reply, the grade. It is the training material
  // (Azizbek, 2026-10-09), not the company's business; a reset starts the
  // company over, it does not erase what the models were measured on. No
  // foreign keys on purpose (see 056), so the walk never reaches it.
  'chat_turn_log',
  // chat_script_requests (058) -- what the eval/scenario scripts spent at
  // the provider today. It is the provider account's count, not the
  // company's: a reset must not hand the daily budget back requests that
  // were already spent. No foreign keys.
  'chat_script_requests',
  // pre_trip_inspections (045) -- the pre-trip walk-around (49 CFR 392.7)
  // names the truck, driver and load it belongs to: company property, all
  // three, and reached by the walk from loads and trucks either way. It is
  // in the WIPE list by name -- the named DELETE is this script's own
  // promise, the same one dvir_reports holds.
  // facilities (035) -- fuel stops, truck stops, rest areas and repair
  // shops placed along lane_routes geometry. Same reasoning as lane_routes
  // directly above: a truck stop sitting on I-40 outside Amarillo is not
  // this company's truck stop, it is the road's, and the next company
  // that opens an account drives past the exact same one. Nothing here
  // references a company table by foreign key (near_city/near_state are
  // plain text, like brokers' own lack of a FK -- see 013's header), so
  // reset-company.js's REACHABLE_SQL walk never even reaches it; it's
  // listed here anyway so companyTables.test.js's "every table is
  // classified" check has an explicit answer instead of an accidental one.
  'facilities',
]))

// Tables that are neither the company's nor the world's -- they are the
// simulation's own bookkeeping and the database's. Named here so that
// test/companyTables.test.js can insist every table in every migration is
// accounted for by exactly one of these three lists. A table added
// tomorrow fails that test tomorrow, in `npm test`, instead of surviving
// a reset in silence six weeks from now.
//   sim_state -- the tick's watermarks (interest clock, refresh cooldown).
//     Wiping it would bill the next company for time from before it existed.
//   user_roles -- which hat a person is wearing. Not the company's.
//   schema_migrations -- written by src/db/migrate.js, not by a migration.
export const INFRASTRUCTURE = Object.freeze(new Set([
  'sim_state',
  'user_roles',
  'schema_migrations',
]))

// Walk the foreign keys outward from the roots and return every table the
// company reaches. This is asked of PostgreSQL rather than written down
// here, because a list written down here is a list that stops being true
// the next time someone adds a table -- which is exactly the failure this
// query exists to catch.
//
// $1 is the root table names. conrelid <> confrelid drops self-references
// (loads has none today; a parent/child column added later would loop the
// recursion forever without it).
export const REACHABLE_SQL = `
  WITH RECURSIVE fk AS (
    SELECT conrelid AS child, confrelid AS parent
      FROM pg_constraint
     WHERE contype = 'f' AND conrelid <> confrelid
  ),
  reach AS (
    SELECT c.oid AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    UNION
    SELECT fk.child FROM fk JOIN reach ON fk.parent = reach.rel
  )
  SELECT DISTINCT c.relname AS table_name
    FROM reach
    JOIN pg_class c ON c.oid = reach.rel
   ORDER BY 1
`

// Table names passed to quoteIdent come from pg_class, not from user
// input. Quoted anyway: an identifier that reaches a query unquoted is a
// habit, and a habit is what is left after the reason for the exception
// is forgotten.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

// Which of the tables the walk reached is this script not accounting for.
//
// It lives here, next to the three lists, because it is the only place
// that knows all three. Both wipe scripts used to ask this question with
// an inline filter over KEEP alone, and both got the same wrong answer
// after migration 046: telegram_deliveries and telegram_attachments hang
// off driver_messages, so the walk reaches them, and they are classified
// as INFRASTRUCTURE -- the bridge's own bookkeeping, cleared by the
// cascade off the messages, not by a named DELETE. Reading them as
// tables nobody has heard of aborted a wipe that had in fact finished.
//
// `wiped` is the set of tables the calling script deletes from by name;
// it differs per script, which is why it is an argument and not a fourth
// list in this file.
export function unknownTables(reached, wiped) {
  return reached.filter((t) => !wiped.has(t) && !KEEP.has(t) && !INFRASTRUCTURE.has(t))
}

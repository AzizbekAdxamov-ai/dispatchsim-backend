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
]))

// Tables that are neither the company's nor the world's -- they are the
// simulation's own bookkeeping and the database's. Named here so that
// test/companyTables.test.js can insist every table in every migration is
// accounted for by exactly one of these three lists. A table added
// tomorrow fails that test tomorrow, in `npm test`, instead of surviving
// a reset in silence six weeks from now.
//
//   sim_state -- the tick's watermarks (interest clock, refresh cooldown).
//     Wiping it would bill the next company for time it did not exist.
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

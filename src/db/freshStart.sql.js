// The statements scripts/fresh-start.js runs, in the order it runs them.
//
// They live here for the reason companyTables.js gives for the recursive
// CTE: a script that connects and deletes on import cannot be imported,
// so anything written inside it is a string nobody parses until the day
// somebody wipes a database with it. From here, scripts/sql-check.js
// PREPAREs every one of them against the real schema, and
// test/companyTables.test.js reads the WIPE order and checks it against
// the foreign keys in the migrations.
//
// Every entry carries its parameter kind as a third element, because
// PREPARE cannot be told a type for a parameter the statement never
// names, and "the drivers list rides along unused" is a fact a dummy
// predicate should not have to pretend is logic:
//
//   'drivers'        $1 = the driver ids to keep, as text[]
//   'trucks'         $1 = the truck ids to keep, as text[]
//   'drivers+trucks' $1 = drivers, $2 = trucks
//   'none'           no parameters

const KINDS = ['drivers', 'trucks', 'drivers+trucks', 'none']

// Marketplace rows that point at something being deleted have to forget
// it FIRST -- not for tidiness. applicants_hired_clean says
// `(status='hired') = (hired_driver_id IS NOT NULL AND hired_at IS NOT
// NULL)`, and the FK is ON DELETE SET NULL, so deleting a hired driver
// would null the id out from under a row still marked 'hired' and the
// CHECK would refuse the delete. The kept drivers are excluded: their
// applicant row stays 'hired', because they still are.
export const RELEASE = [
  ['driver_applicants -> open',
   `UPDATE driver_applicants
       SET status = 'open', hired_driver_id = NULL, hired_by_user_id = NULL, hired_at = NULL
     WHERE status = 'hired'
       AND NOT (hired_driver_id = ANY($1::text[]))`,
   'drivers'],
  // A bought listing whose truck SURVIVES is left alone: it is the
  // truck's provenance, the same way a hired applicant row is the kept
  // driver's. Releasing it would null bought_truck_id out from under a
  // truck still in the fleet. listings_bought_clean is two-sided, so the
  // row cannot be downgraded partially either -- it keeps all three
  // columns or loses all three.
  ['truck_listings -> open',
   `UPDATE truck_listings
       SET status = 'open', bought_truck_id = NULL, bought_by_user_id = NULL, bought_at = NULL
     WHERE status <> 'open'
       AND NOT (bought_truck_id = ANY($1::text[]))`,
   'trucks'],
  ['load_postings -> open',
   `UPDATE load_postings
       SET status = 'open', booked_load_id = NULL, booked_by_user_id = NULL, booked_at = NULL
     WHERE status = 'booked'`,
   'drivers'],
]

// Children before parents, so no foreign key has to be deferred. Every
// table is named even where ON DELETE CASCADE would have carried it:
// a named DELETE is this script's own promise, CASCADE is a promise some
// migration made years ago and may not make again. (reset-company.js
// says the same thing at more length, and for the same reason: migration
// 025 shipped ON DELETE RESTRICT and broke reset in silence.)
//
// Three entries keep rows. driver_qualification is the DQ file -- it
// belongs to the driver, so it lives as long as they do. drivers is the
// point of the whole script. trucks is --keep-truck: the unit keeps its
// COLUMNS (odometer, fuel, tires -- facts about it) while its history
// (the tables above) goes like everyone else's.
export const WIPE = [
  ['driver_messages',      'DELETE FROM driver_messages',              'none'],
  ['driver_conversations', 'DELETE FROM driver_conversations',         'none'],
  ['broker_messages',      'DELETE FROM broker_messages',              'none'],
  ['broker_conversations', 'DELETE FROM broker_conversations',         'none'],
  ['broker_checks',        'DELETE FROM broker_checks',                'none'],
  ['driver_settlements',   'DELETE FROM driver_settlements',           'none'],
  ['load_events',          'DELETE FROM load_events',                  'none'],
  ['alert_acks',           'DELETE FROM alert_acks',                   'none'],
  ['maintenance_records',  'DELETE FROM maintenance_records',          'none'],
  ['truck_daily_metrics',  'DELETE FROM truck_daily_metrics',          'none'],
  ['stop_visits',          'DELETE FROM stop_visits',                  'none'],
  ['duty_events',          'DELETE FROM duty_events',                  'none'],
  ['dvir_reports',         'DELETE FROM dvir_reports',                 'none'],
  ['pre_trip_inspections', 'DELETE FROM pre_trip_inspections',         'none'],
  ['loads',                'DELETE FROM loads',                        'none'],
  ['trucks',               'DELETE FROM trucks WHERE NOT (id = ANY($1::text[]))', 'trucks'],
  ['driver_qualification', 'DELETE FROM driver_qualification WHERE NOT (driver_id = ANY($1::text[]))', 'drivers'],
  ['drivers',              'DELETE FROM drivers WHERE NOT (id = ANY($1::text[]))',     'drivers'],
  ['cash_ledger',          'DELETE FROM cash_ledger',                  'none'],
]

// Which trucks survive, as facts rather than SQL: pure, so the test file
// can kill its mutations without a database.
//
//   --keep-truck given  -> that truck, exactly. A kept driver's own truck
//                          left out is an error, not a silent demotion:
//                          the flag exists to keep ONE unit, and dropping
//                          the driver's own while keeping another reads
//                          as a typo.
//   no --keep-truck     -> each kept driver's own truck comes along
//                          (trucks.driver_id is UNIQUE, so it is theirs).
//                          A kept driver with no truck while the yard
//                          still holds trucks is a refusal: fresh-start
//                          does not strand the person it was told to
//                          keep, and it cannot know WHICH truck they
//                          meant -- that is --keep-truck's job.
//   unknown id          -> an error before anything is touched.
//
// trucks: [{id, driver}] (driver = trucks.driver_id, possibly null).
// drivers: [{id, name, truck}] (truck = the subquery's answer or null).
export function resolveTrucksToKeep({ trucks, drivers, keepDrivers, keepTruckArgs = [] }) {
  const byId = new Map(trucks.map((t) => [t.id, t]))
  const unknown = keepTruckArgs.filter((id) => !byId.has(id))
  if (unknown.length) return { error: `no such truck: ${unknown.join(', ')}` }

  const keep = new Set()
  if (keepTruckArgs.length > 0) {
    for (const id of keepTruckArgs) keep.add(id)
    const stranded = drivers
      .filter((d) => keepDrivers.includes(d.id) && d.truck != null && !keep.has(d.truck))
      .map((d) => `${d.id} (${d.name})`)
    if (stranded.length) {
      return { error: `--keep-truck would leave the kept driver's own truck behind: ${stranded.join(', ')}` }
    }
  } else {
    for (const d of drivers) {
      if (!keepDrivers.includes(d.id)) continue
      if (d.truck != null) keep.add(d.truck)
    }
    const truckless = drivers
      .filter((d) => keepDrivers.includes(d.id) && d.truck == null)
      .map((d) => `${d.id} (${d.name})`)
    if (truckless.length && trucks.length > 0) {
      return { error: `kept driver has no truck: ${truckless.join(', ')}; pass --keep-truck=<id>, ` +
        'or keep nobody, or assign a truck in the app first' }
    }
  }
  return { keep: [...keep] }
}

// A driver who has just been hired, in SQL. The numbers are not invented
// here: 660 minutes and the zeroes are what hr.repository.js's
// insertDriver writes for a new hire, and 100 / 50 are the column
// defaults in migration 005. Where they physically are is left alone --
// that is a fact about the world, not a record of work.
export const RESET_KEPT_DRIVER = `
  UPDATE drivers
     SET duty_status       = 'off',
         hos_remaining_min = 660,
         hours_today_min   = 0,
         hours_week_min    = 0,
         total_miles       = 0,
         safety_rating     = 100,
         broker_rating_x10 = 50,
         updated_at        = now()
   WHERE id = ANY($1::text[])`

// The values a statement of `kind` is executed with. Lives here so the
// contract -- which kind takes which lists -- is next to the statements
// that declare it, and the script cannot invent its own spelling.
export function paramsFor(kind, keepDrivers, keepTrucks) {
  if (!KINDS.includes(kind)) throw new Error(`unknown parameter kind: ${kind}`)
  switch (kind) {
    case 'drivers': return [keepDrivers]
    case 'trucks': return [keepTrucks]
    case 'drivers+trucks': return [keepDrivers, keepTrucks]
    default: return []
  }
}

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
// $1 is always the list of driver ids to keep, as text[].

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
       AND NOT (hired_driver_id = ANY($1::text[]))`],
  ['truck_listings -> open',
   `UPDATE truck_listings
       SET status = 'open', bought_truck_id = NULL, bought_by_user_id = NULL, bought_at = NULL
     WHERE status <> 'open'`],
  ['load_postings -> open',
   `UPDATE load_postings
       SET status = 'open', booked_load_id = NULL, booked_by_user_id = NULL, booked_at = NULL
     WHERE status = 'booked'`],
]

// Children before parents, so no foreign key has to be deferred. Every
// table is named even where ON DELETE CASCADE would have carried it:
// a named DELETE is this script's own promise, CASCADE is a promise some
// migration made years ago and may not make again. (reset-company.js
// says the same thing at more length, and for the same reason: migration
// 025 shipped ON DELETE RESTRICT and broke reset in silence.)
//
// Two entries take the kept-driver list. driver_qualification is the DQ
// file -- it belongs to the driver, so it lives as long as they do.
// drivers is the point of the whole script.
export const WIPE = [
  ['driver_messages',      'DELETE FROM driver_messages'],
  ['driver_conversations', 'DELETE FROM driver_conversations'],
  ['broker_messages',      'DELETE FROM broker_messages'],
  ['broker_conversations', 'DELETE FROM broker_conversations'],
  ['broker_checks',        'DELETE FROM broker_checks'],
  ['driver_settlements',   'DELETE FROM driver_settlements'],
  ['load_events',          'DELETE FROM load_events'],
  ['alert_acks',           'DELETE FROM alert_acks'],
  ['maintenance_records',  'DELETE FROM maintenance_records'],
  ['truck_daily_metrics',  'DELETE FROM truck_daily_metrics'],
  ['stop_visits',          'DELETE FROM stop_visits'],
  ['duty_events',          'DELETE FROM duty_events'],
  ['dvir_reports',         'DELETE FROM dvir_reports'],
  ['pre_trip_inspections', 'DELETE FROM pre_trip_inspections'],
  ['loads',                'DELETE FROM loads'],
  ['trucks',               'DELETE FROM trucks'],
  ['driver_qualification', 'DELETE FROM driver_qualification WHERE NOT (driver_id = ANY($1::text[]))'],
  ['drivers',              'DELETE FROM drivers WHERE NOT (id = ANY($1::text[]))'],
  ['cash_ledger',          'DELETE FROM cash_ledger'],
]

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

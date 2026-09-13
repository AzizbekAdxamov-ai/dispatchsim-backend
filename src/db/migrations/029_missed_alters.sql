-- Two changes that were written into 027 after 027 had already run.
--
-- The migration runner records FILENAMES, not content. Editing an applied
-- migration therefore changes the file and nothing else: the .sql says one
-- thing, the schema says another, and the only symptom is a query failing
-- on a column that is plainly there in the source. That is what happened
-- here -- sql:check reported `column l.event_checked_at does not exist`
-- against a statement whose column was sitting in 027 all along.
--
-- Both statements are idempotent, so a database that gets them from 027
-- (a fresh migrate) and one that gets them here end up identical.
--
-- 028 adds a checksum warning to the runner so the next edit-after-apply
-- says so out loud instead of waiting to be found by a failing query.

-- ---------------------------------------------------------------------
-- 1. loads.event_checked_at
-- ---------------------------------------------------------------------
--
-- The event roll is taken from elapsed time rather than from a tick count,
-- so the rate over a run is the same whether the scheduler fires every 30
-- seconds or every 60. Without this column the roll has nothing to measure
-- from and IN_TRANSIT_LOADS_SQL cannot even parse.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS event_checked_at timestamptz NULL;

-- ---------------------------------------------------------------------
-- 2. 'adjustment' back into ledger_kind
-- ---------------------------------------------------------------------
--
-- 027 rewrote this CHECK to add 'road_event' and dropped 'adjustment',
-- which 019 had allowed. Nothing writes that kind today, so the loss was
-- invisible -- and would have stayed invisible until the first manual
-- correction entry was refused by a constraint nobody remembered
-- narrowing.
ALTER TABLE cash_ledger DROP CONSTRAINT IF EXISTS ledger_kind;
ALTER TABLE cash_ledger ADD CONSTRAINT ledger_kind CHECK (kind IN (
  'opening',
  'truck_purchase',
  'driver_onboarding',
  'fuel',
  'load_payment',
  'settlement',
  'insurance',
  'interest',
  'adjustment',
  'road_event'
));

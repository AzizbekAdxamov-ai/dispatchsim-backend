-- 022: the two costs and the one consequence that were missing.
--
-- 021 was already applied when these were written, and a migration that
-- has run does not run again -- so they get their own file rather than
-- being appended to a file nobody will re-execute.

-- Insurance keeps its own clock, started now rather than at the opening
-- balance: a database that has been migrated for a week should not be
-- billed a week of premiums the moment the first truck is bought.
INSERT INTO sim_state (key, value)
SELECT 'insurance',
       jsonb_build_object(
         'lastAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'accruedUsd', 0
       )
 WHERE NOT EXISTS (SELECT 1 FROM sim_state WHERE key = 'insurance');

-- ---------------------------------------------------------------------
-- Late delivery
-- ---------------------------------------------------------------------
-- No load has ever reached 'warn' or 'crit'. Every UPDATE in the codebase
-- writes only 'ontime' or 'done', so the /loads "Delayed" tab, the
-- dashboard's at-risk tile and the on-time percentage were permanently
-- fixed -- and a late delivery had no consequence of any kind, in a
-- simulator built to teach dispatch.
--
-- Nothing to add to the schema: loads_status_valid already allows both.
-- The gap was that eta_at was DERIVED from the promised window, so a run
-- could never take longer than promised by construction. dispatch.service
-- now rolls a delay factor, and the tick reads the result.
--
-- This index is what lets the tick find loads that have gone late without
-- scanning the table every thirty seconds.
CREATE INDEX IF NOT EXISTS loads_in_transit_idx
  ON loads (delivery_at)
  WHERE delivered_at IS NULL AND status IN ('ontime', 'warn');

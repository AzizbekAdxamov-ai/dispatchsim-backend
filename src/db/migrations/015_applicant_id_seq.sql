-- 015: sequence for driver_applicants ids.
--
-- The generator built ids as `a${index + 1}`, so every run produced a1..a20
-- and the SECOND run failed on driver_applicants_pkey. Worse, the cleanup
-- DELETE ran outside the insert transaction, so a failed run still removed
-- expired rows and still spent AI tokens while inserting nothing.
--
-- Same pattern as booked_load_id_seq (010) and hired_driver_id_seq (011):
-- the database owns the counter, so re-runs and concurrent runs cannot
-- collide. Capped at 999999 to satisfy applicants_id_format ('^a[0-9]{1,6}$').

CREATE SEQUENCE IF NOT EXISTS applicant_id_seq START WITH 1000 INCREMENT BY 1 MAXVALUE 999999 NO CYCLE;

-- Existing rows are a1..a20 from the first run, so starting at 1000 leaves
-- them alone. If the sequence already exists this is a no-op.

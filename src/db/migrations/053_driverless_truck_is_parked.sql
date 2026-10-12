-- 053: a truck whose driver is gone is parked, not working.
--
-- Azizbek, 2026-10-01: the driver page's "Assign truck" offered
-- RS-9278-CY greyed out, "Marked as working without a driver", and
-- nothing could be assigned. The truck was d5's in the seed. When
-- fresh-start removed d5, trucks.driver_id went NULL by its foreign key
-- (006: ON DELETE SET NULL) -- and status stayed 'active'. A truck that
-- is "working" with nobody in it is a state the app has no door out of:
-- assignment takes only idle trucks (truckListings.repository.js), and
-- nothing else ever sets a driverless truck back to idle.
--
-- Three parts:
--   1. The trucks already in that state are parked (status 'idle').
--   2. A trigger parks a truck at the moment its driver is taken off it
--      -- by the foreign key's SET NULL when a driver row is deleted, or
--      by any UPDATE that clears driver_id. This is the release; the
--      truck's columns (odometer, fuel, tires) are untouched.
--   3. A CHECK makes "working with no driver" impossible from now on.
--      006 already says the converse (idle -> no driver); together they
--      say status follows the seat. An INSERT that tries 'active' with no
--      driver is refused loudly rather than quietly corrected -- the
--      trigger only acts on a release, never on a new row.
--
-- 'maintenance' with no driver stays legal: a truck in the shop is in
-- the shop whoever drives it.

UPDATE trucks
   SET status = 'idle', updated_at = now()
 WHERE status = 'active' AND driver_id IS NULL;

CREATE FUNCTION trucks_park_on_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.driver_id IS NOT NULL AND NEW.driver_id IS NULL AND NEW.status = 'active' THEN
    NEW.status := 'idle';
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trucks_park_on_release
  BEFORE UPDATE ON trucks
  FOR EACH ROW EXECUTE FUNCTION trucks_park_on_release();

ALTER TABLE trucks
  ADD CONSTRAINT trucks_active_has_driver CHECK (status <> 'active' OR driver_id IS NOT NULL);

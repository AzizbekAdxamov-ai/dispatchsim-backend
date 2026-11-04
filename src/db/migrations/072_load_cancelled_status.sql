-- 072: a load can be cancelled.
-- Withdrawing an agreement (carrier cancels, or the broker releases the load
-- after a wait with no ETA) left the load created on the rate confirmation
-- at 'neutral' and dispatchable. 'cancelled' is the status that takes it off
-- the board for good; the two CHECKs keep it from carrying a driver, truck,
-- dispatch or delivery.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS cancel_reason text NULL;

ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_status_valid;
ALTER TABLE loads ADD CONSTRAINT loads_status_valid
  CHECK (status IN ('ontime','warn','crit','neutral','done','cancelled'));

ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_cancelled_iff_time;
ALTER TABLE loads ADD CONSTRAINT loads_cancelled_iff_time
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_cancelled_clean;
ALTER TABLE loads ADD CONSTRAINT loads_cancelled_clean
  CHECK (status <> 'cancelled' OR
         (driver_id IS NULL AND truck_id IS NULL AND dispatched_at IS NULL AND delivered_at IS NULL));

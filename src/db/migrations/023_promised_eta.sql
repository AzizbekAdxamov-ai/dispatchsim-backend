-- 023: the promise, on the clock the simulator actually runs on.
--
-- Migration 022 claimed to make late delivery possible. It did not, and
-- the arithmetic says so plainly:
--
--   delivery_at is the broker's promise, copied from the posting
--   (loadBoard.service bookPosting) on the REAL calendar -- pickup is
--   60 to 2880 minutes out and delivery a further 10 to 50 hours after
--   that, so the nearest promise any load can carry is 11 hours away.
--
--   eta_at is set at dispatch on the COMPRESSED calendar, where one
--   simulated day is two real minutes. The longest run the generator
--   produces, with the worst delay factor applied, is 6.7 real minutes.
--
-- 11 hours against 6.7 minutes: a factor of 99. So `eta_at > delivery_at`
-- is false for every load that will ever exist, `now() > delivery_at`
-- cannot arrive before the tick has already delivered the freight, and
-- markLate touches nothing. The Delayed tab, the at-risk tile and the
-- on-time percentage have been reading a number that can only be 100%.
--
-- This is the two-clock hazard the simClock header warns about, and it
-- was shipped anyway: the delay factor was verified (80/15/5 across
-- 100,000 rolls) but nobody checked that lateness could occur at all.
-- Testing the input and calling it a test of the behaviour.
--
-- The fix is a second promise, not a changed one. delivery_at stays
-- exactly as it is: it is what the broker committed to, it is on the
-- rate confirmation, and it is what the dispatcher sees. promised_eta_at
-- is its twin on the simulator's clock, written at dispatch, and it is
-- what the tick compares against.
ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS promised_eta_at timestamptz NULL;

-- A promise only exists once the load has been dispatched, and the ETA
-- cannot be earlier than the moment it left.
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_promise_after_dispatch;
ALTER TABLE loads
  ADD CONSTRAINT loads_promise_after_dispatch CHECK (
    promised_eta_at IS NULL
    OR (dispatched_at IS NOT NULL AND promised_eta_at >= dispatched_at)
  );

-- Replaces the index added in 022, which sorted on delivery_at -- the
-- column the tick no longer reads.
DROP INDEX IF EXISTS loads_in_transit_idx;
CREATE INDEX IF NOT EXISTS loads_in_transit_idx
  ON loads (promised_eta_at)
  WHERE delivered_at IS NULL AND status IN ('ontime', 'warn');

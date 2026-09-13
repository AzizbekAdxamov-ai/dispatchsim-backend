-- Something happened on the road.
--
-- This table replaces delayFactor. A delay used to be rolled at dispatch:
-- the number was decided before the truck moved, nothing said why, and a
-- student watching a load slide to 'crit' had no cause to look at and
-- nothing to do. The distribution was right and the lesson was missing.
--
-- An event is the same delay with a reason and a decision in it. The
-- driver calls it in, the dispatcher picks how to handle it, and the ETA
-- moves because of the choice rather than because of a dice roll nobody
-- saw. eta_at is no longer known in advance -- there is nothing to know
-- until something causes it.

CREATE TABLE IF NOT EXISTS load_events (
  id              bigserial   PRIMARY KEY,
  load_id         text        NOT NULL REFERENCES loads(id) ON DELETE CASCADE,

  event_type      text        NOT NULL,
  -- Where the driver is when they call. Derived from the load's own lane
  -- (origin before halfway, destination after): drivers.current_location
  -- has no runtime writer, and a position read from it would be whatever
  -- the seed happened to say, forever.
  place           text        NOT NULL,

  occurred_at     timestamptz NOT NULL DEFAULT now(),

  -- NULL until the dispatcher chooses. While it is NULL the truck is
  -- stopped: claimArrivedLoads skips loads with an unresolved event, so
  -- ignoring one does not quietly cost nothing.
  resolved_at     timestamptz NULL,
  option_key      text        NULL,

  -- What the chosen option did. Written at resolution, never recomputed,
  -- so the load's history says what was actually charged rather than what
  -- today's constants would charge.
  hours_added     integer     NULL,
  extra_miles     integer     NULL,
  cost_usd        integer     NULL,
  accessorial_usd integer     NULL,

  CONSTRAINT load_events_place_len CHECK (char_length(place) BETWEEN 1 AND 120),
  -- Resolved means all of it or none of it. A row with an option and no
  -- hours would move the ETA by NULL.
  -- 'cancelled' is a real option_key: cancelDispatch closes open events so
  -- an orphan cannot block the load forever. It carries zero hours and
  -- zero money, which the constraint below still requires to be present.
  CONSTRAINT load_events_resolution_whole CHECK (
    (resolved_at IS NULL AND option_key IS NULL AND hours_added IS NULL
     AND extra_miles IS NULL AND cost_usd IS NULL AND accessorial_usd IS NULL)
    OR
    (resolved_at IS NOT NULL AND option_key IS NOT NULL AND hours_added IS NOT NULL
     AND extra_miles IS NOT NULL AND cost_usd IS NOT NULL AND accessorial_usd IS NOT NULL)
  ),
  CONSTRAINT load_events_nonneg CHECK (
    (hours_added IS NULL OR hours_added >= 0)
    AND (extra_miles IS NULL OR extra_miles >= 0)
    AND (cost_usd IS NULL OR cost_usd >= 0)
    AND (accessorial_usd IS NULL OR accessorial_usd >= 0)
  ),
  CONSTRAINT load_events_resolved_after CHECK (resolved_at IS NULL OR resolved_at >= occurred_at)
);

-- One open event per load. The tick rolls every 30 seconds against every
-- load in transit; without this a load left alone for ten minutes would
-- collect a queue of blizzards and the dispatcher would face a stack
-- rather than a decision. Idempotency by constraint, not by remembering.
CREATE UNIQUE INDEX IF NOT EXISTS load_events_one_open
  ON load_events (load_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS load_events_load_idx ON load_events (load_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- The ledger needs a word for this
-- ---------------------------------------------------------------------
--
-- A tow is not fuel. Booking it as 'fuel' would have put $1,450 into the
-- fuel line of every expense report and made cost-per-mile a lie, which is
-- the same class of defect as two settlement systems disagreeing: the
-- number is right and what it is called is not.
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
  -- 'adjustment' was in 019's list and this DROP/ADD nearly deleted it.
  -- Nothing writes it today, so the omission was invisible; the ADD would
  -- have failed validation the first time a manual correction existed, and
  -- taken the whole migration -- road_event included -- down with it.
  'adjustment',
  'road_event'          -- a tow, a detour's fuel, a roadside repair
));

-- The same once-per-reference rule the other spending kinds have. Resolving
-- an event twice is already impossible through the conditional UPDATE on
-- load_events; this makes a duplicate charge impossible in the ledger too,
-- which is where it would actually hurt.
DROP INDEX IF EXISTS cash_ledger_once_per_ref;
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_once_per_ref
  ON cash_ledger (kind, ref_type, ref_id)
  WHERE kind IN ('truck_purchase', 'driver_onboarding', 'fuel',
                 'load_payment', 'settlement', 'road_event');

-- ---------------------------------------------------------------------
-- When this load was last rolled for an event
-- ---------------------------------------------------------------------
--
-- The per-tick probability used to be derived from a hardcoded TICK_MS of
-- 30 seconds. Locally that is the cadence; on Vercel the cron floor is 60
-- seconds, so the deployed app rolled half as often and about one load in
-- TEN met something instead of one in five. The code was right, the config
-- disagreed with it, and the test asserted the code against itself so
-- nothing said so.
--
-- Recording when a load was last checked makes the roll depend on elapsed
-- TIME rather than on how often the scheduler happens to fire. At any
-- cadence -- 30 seconds, 60, a missed hour after a deploy -- the chance
-- over a whole run comes out the same.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS event_checked_at timestamptz NULL;

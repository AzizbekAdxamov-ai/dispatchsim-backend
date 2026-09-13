-- Driver pay becomes a decision.
--
-- Until now a settlement was written straight into cash_ledger the moment
-- a load delivered. The money left the account with nobody choosing to
-- send it, the dispatcher never saw it happen, and a driver had no way to
-- be owed anything -- so there was nothing for a driver to be unhappy
-- about and nothing for a student to learn. Meanwhile /finance/settlements
-- computed a DIFFERENT figure from scratch, on the real calendar, with a
-- status (`periodEnd < oneWeekAgo`) that for the current period could only
-- ever read 'pending'. Two pay systems that disagreed, and the one the
-- student could see was the invented one.
--
-- This table is the single source of truth. A settlement is EARNED at
-- delivery -- that part was already right, and it is the whole squeeze the
-- cash model teaches: the driver is owed this week, the broker pays in
-- thirty. It is PAID when somebody runs payroll. Between those two moments
-- it is a debt, and the driver knows it.

CREATE TABLE IF NOT EXISTS driver_settlements (
  id             bigserial   PRIMARY KEY,
  driver_id      text        NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  load_id        text        NOT NULL REFERENCES loads(id)   ON DELETE RESTRICT,

  -- Whole dollars, like everything else that is money here. Cents would be
  -- false precision in a training tool and integers cannot drift.
  gross_usd      integer     NOT NULL,
  deductions_usd integer     NOT NULL,
  net_usd        integer     NOT NULL,

  -- When the wheels stopped.
  earned_at      timestamptz NOT NULL DEFAULT now(),
  -- When it should have been in the driver's hands. Settlements in US
  -- trucking run weekly; seven simulated days is that norm on this
  -- calendar, and it is the line the driver measures lateness from.
  due_at         timestamptz NOT NULL,
  -- NULL means still owed. This is the only mutable column.
  paid_at        timestamptz NULL,

  -- Idempotency by constraint, not by remembering to check. The tick runs
  -- every 30 seconds and retries after a failure; without this, one
  -- delivery could earn a driver two settlements and there would be no
  -- way to tell which was the real one.
  CONSTRAINT settlement_one_per_load UNIQUE (load_id),

  -- The arithmetic is stated here rather than trusted from the caller.
  CONSTRAINT settlement_net_matches CHECK (net_usd = gross_usd - deductions_usd),
  -- A settlement that takes money back off a driver is not something this
  -- simulator should be able to produce by accident.
  CONSTRAINT settlement_nonneg CHECK (gross_usd >= 0 AND deductions_usd >= 0 AND net_usd >= 0),
  CONSTRAINT settlement_due_after_earned CHECK (due_at >= earned_at),
  CONSTRAINT settlement_paid_after_earned CHECK (paid_at IS NULL OR paid_at >= earned_at)
);

-- The two reads that matter: what is owed to everyone (payroll), and what
-- is owed to one driver (whether they will take the next load).
CREATE INDEX IF NOT EXISTS driver_settlements_unpaid_idx
  ON driver_settlements (due_at) WHERE paid_at IS NULL;
CREATE INDEX IF NOT EXISTS driver_settlements_driver_idx
  ON driver_settlements (driver_id, paid_at);

-- ---------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------
--
-- Every load already delivered with a driver on it produced a settlement
-- entry in cash_ledger, so that money is already gone. Those become PAID
-- rows here, dated to the ledger entry, so the Settlements page shows a
-- history instead of starting empty and implying nobody was ever paid.
--
-- The amounts are read back off the ledger rather than recomputed. A
-- recomputation could disagree with what actually left the account, and
-- then two numbers would describe one payment -- which is the exact defect
-- this migration exists to remove.
INSERT INTO driver_settlements (
  driver_id, load_id, gross_usd, deductions_usd, net_usd, earned_at, due_at, paid_at
)
SELECT l.driver_id,
       l.id,
       -- Ledger amounts are negative (money leaving); a settlement is a
       -- positive amount owed. abs() is the sign flip.
       abs(c.amount_usd),
       0,
       abs(c.amount_usd),
       l.delivered_at,
       -- due_at = earned_at for these rows on purpose. They are already
       -- paid, so nothing ever reads their due date, and inventing one
       -- would put a fabricated deadline in a table whose entire job is to
       -- be the one true record.
       l.delivered_at,
       c.occurred_at
  FROM loads l
  JOIN cash_ledger c
    ON c.kind = 'settlement' AND c.ref_type = 'load' AND c.ref_id = l.id
 WHERE l.driver_id IS NOT NULL AND l.delivered_at IS NOT NULL
ON CONFLICT (load_id) DO NOTHING;

-- The ledger recorded only the NET that left the account; gross and
-- deductions were never stored anywhere. Rather than invent them, the
-- backfilled rows carry gross = net and deductions = 0, which is the
-- honest reading of what the ledger knows. Rows written from here on have
-- all three.

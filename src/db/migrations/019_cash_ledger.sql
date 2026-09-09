-- 019: the company's money.
--
-- Until now nothing cost anything. A truck was bought for free, a driver
-- was hired for free, and Finance was a calculator drawing numbers off the
-- loads table -- there were no invoices, no account, nothing that could go
-- down. Every decision the student made was weightless.
--
-- The balance is NOT a column. It is the sum of this table, always, and is
-- computed on read. A stored balance and a list of transactions are two
-- copies of the same fact, and the day they disagree there is no way to
-- tell which one lied. This way the history IS the balance, and Finance
-- can answer the only question that matters: where did the money go.

CREATE TABLE IF NOT EXISTS cash_ledger (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  -- Signed. Negative is money leaving. Whole dollars: cents would be
  -- false precision in a training tool, and integers cannot drift.
  amount_usd  integer NOT NULL,
  description text NOT NULL,
  -- What this row is about, so Finance can link back to the truck or the
  -- load. ref_id is text because ids in this schema are text ('t1042',
  -- '600007', a uuid) depending on the table.
  ref_type    text NULL,
  ref_id      text NULL,
  created_by  uuid NULL REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ledger_kind CHECK (kind IN (
    'opening',            -- the company's starting cash
    'truck_purchase',
    'driver_onboarding',  -- physical, drug screen, orientation
    'fuel',
    'load_payment',       -- the broker finally pays
    'settlement',         -- driver pay
    'insurance',
    'interest',           -- the cost of running on the credit line
    'adjustment'
  )),
  CONSTRAINT ledger_amount_nonzero CHECK (amount_usd <> 0),
  CONSTRAINT ledger_desc_len CHECK (char_length(description) BETWEEN 1 AND 200),
  CONSTRAINT ledger_ref_pair CHECK ((ref_type IS NULL) = (ref_id IS NULL))
);

CREATE INDEX IF NOT EXISTS cash_ledger_time
  ON cash_ledger (occurred_at DESC, id DESC);

-- Exactly one opening balance, ever. Re-running the reset script must not
-- quietly hand the company another $200,000.
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_one_opening
  ON cash_ledger (kind) WHERE kind = 'opening';

-- A load is fuelled once and paid once; a truck is bought once. These
-- indexes are what make the background tick safe to run every thirty
-- seconds: a second attempt at the same event is rejected by the database
-- rather than prevented by remembering to check first.
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_once_per_ref
  ON cash_ledger (kind, ref_type, ref_id)
  WHERE kind IN ('truck_purchase', 'driver_onboarding', 'fuel', 'load_payment', 'settlement');

-- ---------------------------------------------------------------------
-- Load lifecycle
-- ---------------------------------------------------------------------

-- When the money is actually due. Set at delivery from the broker's
-- payment terms, on the compressed calendar (see src/constants/simClock.js
-- -- one simulated day is two real minutes, so net60 lands two hours after
-- delivery instead of two months). Without compression a student would
-- never once see an invoice get paid, and the whole point of checking a
-- broker's credit is that slow payment is something you FEEL.
ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS invoice_due_at timestamptz NULL;

-- Can only be due if it has been delivered.
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_due_after_del;
ALTER TABLE loads
  ADD CONSTRAINT loads_due_after_del CHECK (
    invoice_due_at IS NULL OR (delivered_at IS NOT NULL AND invoice_due_at >= delivered_at)
  );

CREATE INDEX IF NOT EXISTS loads_invoice_due_idx
  ON loads (invoice_due_at)
  WHERE invoice_paid_at IS NULL AND invoice_due_at IS NOT NULL;

-- Loads the tick has to look at: dispatched, not yet delivered.
CREATE INDEX IF NOT EXISTS loads_eta_open_idx
  ON loads (eta_at)
  WHERE delivered_at IS NULL AND eta_at IS NOT NULL;

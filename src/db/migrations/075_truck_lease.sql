-- 075: weekly truck lease (Azizbek, 2026-11-10).
--
-- is_leased marks the company trucks provisioned for lease; rent runs only
-- while a driver is assigned. lease_billed_through is the watermark of the
-- last charge (NULL = not running); lease_accrued_usd carries the part of a
-- dollar not yet written to the ledger. Existing trucks stay is_leased=false.
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS is_leased boolean NOT NULL DEFAULT false;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS lease_billed_through timestamptz NULL;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS lease_accrued_usd numeric(12,6) NOT NULL DEFAULT 0;

ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_lease_running;
ALTER TABLE trucks ADD CONSTRAINT trucks_lease_running
  CHECK (lease_billed_through IS NULL OR (is_leased AND driver_id IS NOT NULL));
ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_lease_accrued_nonneg;
ALTER TABLE trucks ADD CONSTRAINT trucks_lease_accrued_nonneg CHECK (lease_accrued_usd >= 0);

-- The full list from 032 plus 'truck_lease' (a CHECK rewrite that drops a
-- kind is the 027 mistake).
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
  'road_event',
  'maintenance',
  'truck_lease'
));

-- rate_usd stays the complete freight payment. Existing totals never change.
ALTER TABLE load_postings
  ADD COLUMN rate_basis text NOT NULL DEFAULT 'all-in',
  ADD COLUMN fuel_surcharge_usd integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT load_postings_rate_basis CHECK (rate_basis IN ('all-in', 'linehaul-plus-fuel')),
  ADD CONSTRAINT load_postings_fuel_parts CHECK (fuel_surcharge_usd >= 0 AND fuel_surcharge_usd <= rate_usd
    AND ((rate_basis = 'linehaul-plus-fuel' AND fuel_surcharge_usd > 0 AND fuel_surcharge_usd < rate_usd) OR (rate_basis = 'all-in' AND fuel_surcharge_usd = 0)));

ALTER TABLE loads
  ADD COLUMN rate_basis text NOT NULL DEFAULT 'all-in',
  ADD COLUMN fuel_surcharge_usd integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT loads_rate_basis CHECK (rate_basis IN ('all-in', 'linehaul-plus-fuel')),
  ADD CONSTRAINT loads_fuel_parts CHECK (fuel_surcharge_usd >= 0 AND fuel_surcharge_usd <= rate_usd
    AND ((rate_basis = 'linehaul-plus-fuel' AND fuel_surcharge_usd > 0 AND fuel_surcharge_usd < rate_usd) OR (rate_basis = 'all-in' AND fuel_surcharge_usd = 0)));

-- Nullable means an older paper did not itemize fuel. Snapshot fields are
-- frozen/cleared together with rate_con_rate_usd, not derived from a later posting.
ALTER TABLE broker_conversations
  ADD COLUMN rate_con_basis text,
  ADD COLUMN rate_con_fuel_surcharge_usd integer,
  ADD CONSTRAINT broker_conversations_rate_con_parts CHECK (
    (rate_con_basis IS NULL AND rate_con_fuel_surcharge_usd IS NULL)
    OR (rate_con_rate_usd IS NOT NULL AND rate_con_basis IS NOT NULL AND rate_con_basis IN ('all-in', 'linehaul-plus-fuel')
      AND rate_con_fuel_surcharge_usd IS NOT NULL
      AND rate_con_fuel_surcharge_usd >= 0 AND rate_con_fuel_surcharge_usd <= rate_con_rate_usd
      AND ((rate_con_basis = 'linehaul-plus-fuel' AND rate_con_fuel_surcharge_usd > 0 AND rate_con_fuel_surcharge_usd < rate_con_rate_usd)
        OR (rate_con_basis = 'all-in' AND rate_con_fuel_surcharge_usd = 0))));

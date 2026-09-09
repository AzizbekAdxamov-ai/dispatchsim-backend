-- 020: the spec sheet a used truck is actually bought from.
--
-- A listing had eight fields. Nobody spends $55,000 on a tractor off eight
-- fields, and more to the point a student learns nothing from them: the
-- decision they are meant to practise is reading a spec sheet and working
-- out whether the price matches what is in front of them.
--
-- Every column here changes something:
--   sleeper      a day cab cannot run a lane that takes more than a shift
--   rear_axle    decides whether 44,000 lbs of grain is legal behind it
--   transmission a manual gearbox narrows who you can hire to drive it
--   location     the truck is somewhere, and you have to go and get it
--   has_apu      runs the cab without idling the engine, which is fuel
--
-- Decoration is deliberately absent. No seat material, no cabinet count,
-- no wood grain dash: a field that cannot change a decision is noise on a
-- page whose whole job is to make one decision harder.
--
-- All of it is DERIVED in src/constants/truckSpecs.js from the make,
-- model, year and trailer type the generator already produces. Nothing is
-- asked of the model, so nothing new can fail validation and none of it
-- costs a token.

-- Nullable on purpose: listings generated before this migration keep
-- working and simply show "—". They expire within about sixteen hours
-- anyway, so a backfill would be work in exchange for nothing.
DO $$
DECLARE
  t text;
BEGIN
  -- The same columns go on BOTH tables. A spec sheet that vanishes the
  -- moment you buy the truck is worse than not having one: the fleet page
  -- is exactly where you go to ask "can this truck take that load?".
  FOREACH t IN ARRAY ARRAY['truck_listings', 'trucks'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS vin text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engine_make text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS engine_model text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS horsepower smallint NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS transmission text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS sleeper text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS suspension text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS axle_config text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS wheelbase_in smallint NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS front_axle_lbs integer NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS rear_axle_lbs integer NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS gvwr_lbs integer NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS has_apu boolean NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS location_city text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS location_state text NULL', t);

    -- Closed sets, so a typo in the generator fails here rather than
    -- reaching a page as an unlabelled key.
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_transmission_valid');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (transmission IS NULL OR transmission IN ('manual-10','manual-13','automated-12'))$f$,
      t, t || '_transmission_valid');

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_sleeper_valid');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (sleeper IS NULL OR sleeper IN ('day-cab','sleeper-72','sleeper-82'))$f$,
      t, t || '_sleeper_valid');

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_suspension_valid');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (suspension IS NULL OR suspension IN ('air-ride','spring'))$f$,
      t, t || '_suspension_valid');

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_axle_valid');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (axle_config IS NULL OR axle_config IN ('6x4','6x2','4x2'))$f$,
      t, t || '_axle_valid');

    -- A VIN is seventeen characters. Anyone who works with trucks spots a
    -- wrong length instantly.
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_vin_len');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (vin IS NULL OR char_length(vin) = 17)$f$, t, t || '_vin_len');

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_weights_sane');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      ((front_axle_lbs IS NULL OR front_axle_lbs BETWEEN 8000 AND 22000)
       AND (rear_axle_lbs IS NULL OR rear_axle_lbs BETWEEN 30000 AND 60000)
       AND (gvwr_lbs IS NULL OR gvwr_lbs BETWEEN 30000 AND 90000))$f$,
      t, t || '_weights_sane');

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_state_code');
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK
      (location_state IS NULL OR location_state ~ '^[A-Z]{2}$')$f$,
      t, t || '_state_code');
  END LOOP;
END $$;

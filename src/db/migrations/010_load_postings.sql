-- 1.1: load_postings table
CREATE TABLE IF NOT EXISTS load_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_lat double precision NOT NULL,
  origin_lon double precision NOT NULL,
  destination_lat double precision NOT NULL,
  destination_lon double precision NOT NULL,
  origin_city text NOT NULL,
  origin_state text NOT NULL,
  destination_city text NOT NULL,
  destination_state text NOT NULL,
  broker text NOT NULL,
  commodity text NOT NULL,
  rate_usd integer NOT NULL,
  distance_mi integer NOT NULL,
  weight_lbs integer NOT NULL,
  equipment_type text NOT NULL,
  equipment_length_ft integer NOT NULL,
  posted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  pickup_at timestamptz NOT NULL,
  delivery_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  booked_load_id text NULL,
  booked_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  booked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT postings_state_codes CHECK (origin_state ~ '^[A-Z]{2}$' AND destination_state ~ '^[A-Z]{2}$'),
  CONSTRAINT postings_not_same_place CHECK (origin_city <> destination_city OR origin_state <> destination_state),
  CONSTRAINT postings_broker_len CHECK (char_length(broker) BETWEEN 2 AND 120),
  CONSTRAINT postings_rate_range CHECK (rate_usd BETWEEN 100 AND 20000),
  CONSTRAINT postings_distance CHECK (distance_mi BETWEEN 25 AND 3500),
  CONSTRAINT postings_rpm_band CHECK (rate_usd BETWEEN distance_mi * 1 AND distance_mi * 5),
  CONSTRAINT postings_weight CHECK (weight_lbs BETWEEN 500 AND 45000),
  CONSTRAINT postings_equipment CHECK (equipment_type IN ('dry-van','reefer','flatbed','step-deck','tanker','power-only')),
  CONSTRAINT postings_equip_length CHECK (equipment_length_ft IN (28,42,45,48,53)),
  CONSTRAINT postings_status_valid CHECK (status IN ('open','booked')),
  CONSTRAINT postings_time_order CHECK (posted_at < expires_at AND expires_at <= pickup_at AND pickup_at < delivery_at),
  CONSTRAINT postings_booked_clean CHECK ((status = 'booked') = (booked_by_user_id IS NOT NULL AND booked_at IS NOT NULL)),
  CONSTRAINT postings_lat_range CHECK (origin_lat >= -90 AND origin_lat <= 90 AND destination_lat >= -90 AND destination_lat <= 90),
  CONSTRAINT postings_lon_range CHECK (origin_lon >= -180 AND origin_lon <= 180 AND destination_lon >= -180 AND destination_lon <= 180)
);

CREATE INDEX IF NOT EXISTS idx_load_postings_posted_at_desc ON load_postings(posted_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_load_postings_expires_at ON load_postings(expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_load_postings_equipment_type ON load_postings(equipment_type) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_load_postings_origin_state ON load_postings(origin_state) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_load_postings_booked_load_id ON load_postings(booked_load_id) WHERE booked_load_id IS NOT NULL;

-- 1.2: Driver location columns
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_city text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_state text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_lat double precision;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_lon double precision;

-- 1.3: Truck trailer type
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS trailer_type text;

-- 1.4: Sequence for booked load IDs
CREATE SEQUENCE IF NOT EXISTS booked_load_id_seq START WITH 600000 INCREMENT BY 1 MAXVALUE 999999 NO CYCLE;

-- SQL function: road_miles
CREATE OR REPLACE FUNCTION road_miles(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 3958.8 * 1.18 * 2 * asin(least(1.0, sqrt(sin(radians(lat2 - lat1) / 2.0) ^ 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2.0) ^ 2)));
$$;

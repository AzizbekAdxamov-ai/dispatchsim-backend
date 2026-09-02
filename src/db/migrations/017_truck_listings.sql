CREATE TABLE IF NOT EXISTS truck_listings (
  id                text PRIMARY KEY,
  make              text NOT NULL,
  model             text NOT NULL,
  year              smallint NOT NULL,
  odometer_mi       integer NOT NULL,
  price_usd         integer NOT NULL,
  trailer_type      text NOT NULL,
  fuel_capacity_gal integer NOT NULL,
  -- Ko'rinadigan holat: shina va yozuvlar. Arzon eski trak ko'proq ta'mir
  -- talab qiladi — bu fleet va finance bo'limlarini bog'laydi.
  tire_front_pct    smallint NOT NULL,
  tire_rear_pct     smallint NOT NULL,
  service_notes     text NOT NULL,
  seller            text NOT NULL,
  posted_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'open',
  bought_truck_id   text NULL REFERENCES trucks(id) ON DELETE SET NULL,
  bought_by_user_id uuid NULL REFERENCES users(id)  ON DELETE SET NULL,
  bought_at         timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT listings_id_format  CHECK (id ~ '^t[0-9]{1,6}$'),
  CONSTRAINT listings_status     CHECK (status IN ('open','bought')),
  CONSTRAINT listings_bought_clean CHECK ((status = 'bought') =
    (bought_truck_id IS NOT NULL AND bought_at IS NOT NULL)),
  CONSTRAINT listings_year       CHECK (year BETWEEN 1995 AND 2030),
  CONSTRAINT listings_odometer   CHECK (odometer_mi BETWEEN 0 AND 2000000),
  CONSTRAINT listings_price      CHECK (price_usd BETWEEN 5000 AND 250000),
  CONSTRAINT listings_capacity   CHECK (fuel_capacity_gal BETWEEN 50 AND 400),
  CONSTRAINT listings_tires      CHECK (tire_front_pct BETWEEN 0 AND 100
                                    AND tire_rear_pct  BETWEEN 0 AND 100),
  CONSTRAINT listings_trailer    CHECK (trailer_type IN
    ('dry-van','reefer','flatbed','step-deck','tanker','power-only')),
  CONSTRAINT listings_time_order CHECK (posted_at < expires_at)
);

CREATE INDEX IF NOT EXISTS idx_truck_listings_open
  ON truck_listings (posted_at DESC) WHERE status = 'open';

-- id ketma-ketligi — massiv indeksidan YASAMA. 2026-08-31 da nomzodlarda
-- aynan shu xato ikkinchi yugurishni driver_applicants_pkey da yiqitgan.
CREATE SEQUENCE IF NOT EXISTS truck_listing_id_seq
  START WITH 1000 INCREMENT BY 1 MAXVALUE 999999 NO CYCLE;

-- Sotib olingan trakning davlat raqami uchun.
CREATE SEQUENCE IF NOT EXISTS bought_truck_plate_seq
  START WITH 1000 INCREMENT BY 1 MAXVALUE 9999 NO CYCLE;

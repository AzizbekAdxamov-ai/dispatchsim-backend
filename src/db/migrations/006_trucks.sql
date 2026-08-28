-- Truck parki. id = AQSh nomer belgisi, shartnoma §3 boʻyicha ('TX-4821-HX').
CREATE TABLE IF NOT EXISTS trucks (
  id                    text        PRIMARY KEY,
  make                  text        NOT NULL,
  model                 text        NOT NULL,
  year                  smallint    NOT NULL,
  odometer_mi           integer     NOT NULL,
  status                text        NOT NULL,
  -- UNIQUE: bir haydovchi bir vaqtda bitta truckka biriktiriladi.
  -- Mockdagi `drivers[].unit` shu bogʻlanishdan hosil qilinadi — ustun emas,
  -- shuning uchun ular hech qachon bir-biriga zid boʻla olmaydi
  -- (hozir mockda zid: unit='T-118', truck id='TX-4821-HX').
  driver_id             text        NULL UNIQUE REFERENCES drivers(id) ON DELETE SET NULL,
  current_location      text        NULL,
  fuel_pct              smallint    NOT NULL,
  fuel_gallons          integer     NOT NULL,
  fuel_capacity_gal     integer     NOT NULL DEFAULT 240,
  last_fueled_at        timestamptz NULL,
  last_fueled_location  text        NULL,
  tire_front_pct        smallint    NOT NULL,
  tire_rear_pct         smallint    NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trucks_plate_format   CHECK (id ~ '^[A-Z]{2}-[0-9]{4}-[A-Z]{2}$'),
  CONSTRAINT trucks_year_range     CHECK (year BETWEEN 1995 AND 2030),
  CONSTRAINT trucks_odometer       CHECK (odometer_mi BETWEEN 0 AND 2000000),
  CONSTRAINT trucks_status_valid   CHECK (status IN ('active','maintenance','idle')),
  CONSTRAINT trucks_fuel_pct       CHECK (fuel_pct BETWEEN 0 AND 100),
  CONSTRAINT trucks_capacity       CHECK (fuel_capacity_gal BETWEEN 50 AND 400),
  -- Gallon hech qachon bakdan katta boʻlmaydi — mockda buni hech nima ushlab
  -- turmaydi, bazada esa imkonsiz.
  CONSTRAINT trucks_gallons        CHECK (fuel_gallons BETWEEN 0 AND fuel_capacity_gal),
  CONSTRAINT trucks_tire_front     CHECK (tire_front_pct BETWEEN 0 AND 100),
  CONSTRAINT trucks_tire_rear      CHECK (tire_rear_pct  BETWEEN 0 AND 100),
  -- Boʻsh turgan truckka haydovchi biriktirilmaydi (mock ham shunday).
  CONSTRAINT trucks_idle_no_driver CHECK (status <> 'idle' OR driver_id IS NULL),
  CONSTRAINT trucks_fuel_log       CHECK ((last_fueled_at IS NULL) = (last_fueled_location IS NULL))
);

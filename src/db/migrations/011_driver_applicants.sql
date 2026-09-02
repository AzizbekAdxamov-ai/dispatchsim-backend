CREATE TABLE IF NOT EXISTS driver_applicants (
  id                    text PRIMARY KEY,
  full_name             text NOT NULL,
  email                 text NOT NULL UNIQUE,
  phone                 text NOT NULL,
  cdl_class             text NOT NULL,
  cdl_state             text NOT NULL,
  license_expires_on    date NOT NULL,
  years_experience      integer NOT NULL,
  home_base_city        text NOT NULL,
  home_base_state       text NOT NULL,
  endorsements          text[] NOT NULL DEFAULT '{}',
  desired_equipment     text NOT NULL,
  mvr_violations        integer NOT NULL DEFAULT 0,
  preventable_accidents integer NOT NULL DEFAULT 0,
  employment_gap_months integer NOT NULL DEFAULT 0,
  desired_pay_model     text NOT NULL,
  desired_pay_percent_bp     integer NULL,
  desired_pay_per_mile_cents smallint NULL,
  available_from        timestamptz NOT NULL,
  posted_at             timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  hired_driver_id       text NULL REFERENCES drivers(id) ON DELETE SET NULL,
  hired_by_user_id      uuid NULL REFERENCES users(id)   ON DELETE SET NULL,
  hired_at              timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT applicants_id_format   CHECK (id ~ '^a[0-9]{1,6}$'),
  CONSTRAINT applicants_status      CHECK (status IN ('open','hired')),
  CONSTRAINT applicants_hired_clean CHECK ((status = 'hired') =
    (hired_driver_id IS NOT NULL AND hired_at IS NOT NULL)),
  CONSTRAINT applicants_email_lower CHECK (email = lower(email)),
  CONSTRAINT applicants_email_fmt   CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT applicants_cdl_class   CHECK (cdl_class IN ('A','B')),
  CONSTRAINT applicants_state_codes CHECK (home_base_state ~ '^[A-Z]{2}$' AND cdl_state ~ '^[A-Z]{2}$'),
  CONSTRAINT applicants_experience  CHECK (years_experience BETWEEN 0 AND 45),
  CONSTRAINT applicants_mvr         CHECK (mvr_violations BETWEEN 0 AND 20),
  CONSTRAINT applicants_accidents   CHECK (preventable_accidents BETWEEN 0 AND 10),
  CONSTRAINT applicants_gap         CHECK (employment_gap_months BETWEEN 0 AND 240),
  CONSTRAINT applicants_equipment   CHECK (desired_equipment IN
    ('dry-van','reefer','flatbed','step-deck','tanker','power-only')),
  CONSTRAINT applicants_pay_model   CHECK (desired_pay_model IN ('percent','permile')),
  CONSTRAINT applicants_pay_one_of  CHECK (
    (desired_pay_percent_bp IS NOT NULL) <> (desired_pay_per_mile_cents IS NOT NULL)),
  CONSTRAINT applicants_pay_percent CHECK (desired_pay_percent_bp IS NULL
    OR desired_pay_percent_bp BETWEEN 1000 AND 5000),
  CONSTRAINT applicants_pay_cents   CHECK (desired_pay_per_mile_cents IS NULL
    OR desired_pay_per_mile_cents BETWEEN 30 AND 120),
  CONSTRAINT applicants_time_order  CHECK (posted_at < expires_at)
);

CREATE INDEX IF NOT EXISTS idx_applicants_expires  ON driver_applicants(expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_applicants_posted   ON driver_applicants(posted_at DESC) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_applicants_hired_driver
  ON driver_applicants(hired_driver_id) WHERE hired_driver_id IS NOT NULL;

-- Yollangan nomzod uchun drivers.id ketma-ketligi.
-- drivers_id_format: '^d[0-9]{1,4}$' → maksimum d9999.
-- 100 dan boshlanadi: mavjud seed haydovchilari (d1..d30) bilan to'qnashmasin.
CREATE SEQUENCE IF NOT EXISTS hired_driver_id_seq START WITH 100 INCREMENT BY 1 MAXVALUE 9999 NO CYCLE;

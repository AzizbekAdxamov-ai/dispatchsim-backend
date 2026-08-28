-- Haydovchilar. `users` bilan bogʻlanmaydi — bular talaba boshqaradigan
-- personajlar, tizimga kiradigan hisoblar emas.
--
-- ⚠️ UI LABEL BAZAGA TUSHMAYDI. Mockdagi `status: 'On route'`, `state: 'on'`,
-- `meta: 'Driving — I-40 near Memphis'`, `unit: 'Freightliner — T-118'`
-- shu yerda YOʻQ. Ular `duty_status` + biriktirilgan yuk + biriktirilgan
-- truckdan frontendda hosil qilinadi (equipmentType naqshi: kalit saqlanadi,
-- label frontendda).
--
-- ⚠️ `safetyScore` → `safety_rating`. "Score" — taqiqlangan soʻz
-- (Mahsulot-qoidalari §2). Migratsiya — uni tuzatish uchun toʻgʻri payt.
CREATE TABLE IF NOT EXISTS drivers (
  id                   text        PRIMARY KEY,
  name                 text        NOT NULL,
  email                text        NOT NULL UNIQUE,
  phone                text        NOT NULL,
  cdl_class            text        NOT NULL DEFAULT 'A',
  cdl_number           text        NOT NULL UNIQUE,
  license_expires_on   date        NOT NULL,
  home_base_city       text        NOT NULL,
  home_base_state      text        NOT NULL,
  -- Erkin matn: 'I-40 near Memphis, TN' yoki 'Dallas, TX yard'.
  -- Koordinata emas — GPS keyingi bosqich (tracking bilan birga).
  current_location     text        NULL,
  duty_status          text        NOT NULL,
  hos_remaining_min    integer     NULL,      -- NULL = off duty (mockda '—')
  hours_today_min      integer     NOT NULL DEFAULT 0,
  hours_week_min       integer     NOT NULL DEFAULT 0,
  total_miles          integer     NOT NULL DEFAULT 0,
  safety_rating        smallint    NOT NULL DEFAULT 100,
  -- Broker qoʻygan reyting, oʻndan bir aniqlikda: 49 = 4.9.
  -- numeric(2,1) ATAYLAB ISHLATILMAYDI — node-pg numeric ni satr qilib
  -- qaytaradi va frontendda jimgina buziladi.
  broker_rating_x10    smallint    NOT NULL DEFAULT 50,
  -- Maosh sxemasi. financeData.js dagi PAY_PLANS shu yerga koʻchadi:
  -- hisoblab boʻlmaydigan fakt, shuning uchun ustun.
  pay_model            text        NOT NULL,
  pay_percent_bp       integer     NULL,      -- bazis punkt: 2700 = 27%
  pay_per_mile_cents   smallint    NULL,      -- 62 = $0.62/mi
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drivers_id_format      CHECK (id ~ '^d[0-9]{1,4}$'),
  CONSTRAINT drivers_name_len       CHECK (char_length(name) BETWEEN 2 AND 120),
  CONSTRAINT drivers_email_lower    CHECK (email = lower(email)),
  CONSTRAINT drivers_email_format   CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT drivers_state_code     CHECK (home_base_state ~ '^[A-Z]{2}$'),
  CONSTRAINT drivers_cdl_class      CHECK (cdl_class IN ('A','B','C')),
  CONSTRAINT drivers_duty_status    CHECK (duty_status IN ('driving','on-duty','resting','off')),
  -- FMCSA: kunlik 11 soat rul (660 daq), 14 soat smena, haftada 70 soat.
  CONSTRAINT drivers_hos_range      CHECK (hos_remaining_min IS NULL OR hos_remaining_min BETWEEN 0 AND 660),
  CONSTRAINT drivers_hours_today    CHECK (hours_today_min  BETWEEN 0 AND 840),
  CONSTRAINT drivers_hours_week     CHECK (hours_week_min   BETWEEN 0 AND 4200),
  CONSTRAINT drivers_total_miles    CHECK (total_miles      >= 0),
  CONSTRAINT drivers_safety_rating  CHECK (safety_rating    BETWEEN 0 AND 100),
  CONSTRAINT drivers_broker_rating  CHECK (broker_rating_x10 BETWEEN 0 AND 50),
  CONSTRAINT drivers_pay_model      CHECK (pay_model IN ('percent','permile')),
  -- Aynan bittasi toʻldirilgan boʻlishi shart — ikkalasi ham, hech biri ham emas.
  CONSTRAINT drivers_pay_one_of     CHECK (
    (pay_model = 'percent' AND pay_percent_bp     IS NOT NULL AND pay_per_mile_cents IS NULL) OR
    (pay_model = 'permile' AND pay_per_mile_cents IS NOT NULL AND pay_percent_bp     IS NULL)
  ),
  CONSTRAINT drivers_pay_percent    CHECK (pay_percent_bp     IS NULL OR pay_percent_bp     BETWEEN 1000 AND 5000),
  CONSTRAINT drivers_pay_cents      CHECK (pay_per_mile_cents IS NULL OR pay_per_mile_cents BETWEEN 30 AND 120)
);

CREATE INDEX IF NOT EXISTS drivers_duty_status_idx ON drivers (duty_status);

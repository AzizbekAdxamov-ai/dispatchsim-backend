-- Yuklar. Loyihaning markaziy jadvali.
--
-- ⚠️ Shartnomadagi RAW qoidasi shu yerda eng koʻp koʻrinadi:
--   mock 'Dallas, TX'        → origin_city + origin_state
--   mock '282 mi'            → distance_mi integer
--   mock '28,700 lbs'        → weight_lbs integer
--   mock 'Aug 19, 08:00'     → pickup_at timestamptz
--   mock '53ft'              → equipment_length_ft smallint
-- Formatlash — faqat frontendda (src/utils/format.js).
CREATE TABLE IF NOT EXISTS loads (
  id                   text        PRIMARY KEY,
  origin_city          text        NOT NULL,
  origin_state         text        NOT NULL,
  destination_city     text        NOT NULL,
  destination_state    text        NOT NULL,
  -- Hozircha matn. Broker alohida jadval boʻlishi kerak, lekin bu broker
  -- chat/inson-rol qismi bilan birga keladi — u yerda kontakt, javob vaqti,
  -- reyting ham boʻladi. Bugun matn ustun yetarli va keyin FK ga oʻsadi.
  broker               text        NOT NULL,
  commodity            text        NOT NULL DEFAULT '',
  -- Butun dollar. Kasrli pul saqlanmaydi — Q2 ga qara.
  rate_usd             integer     NOT NULL,
  distance_mi          integer     NOT NULL,
  weight_lbs           integer     NOT NULL,
  -- KALIT, label emas. Yagona manba: frontend/src/data/equipmentTypes.js.
  equipment_type       text        NOT NULL,
  equipment_length_ft  smallint    NOT NULL,
  status               text        NOT NULL,
  driver_id            text        NULL REFERENCES drivers(id) ON DELETE SET NULL,
  truck_id             text        NULL REFERENCES trucks(id)  ON DELETE SET NULL,

  -- Vaqt chizigʻi shu toʻrt ustundan hosil qilinadi — alohida jadval emas.
  booked_at            timestamptz NOT NULL,
  pickup_at            timestamptz NOT NULL,
  delivery_at          timestamptz NOT NULL,   -- VAʼDA (shartnomadagi oyna)
  dispatched_at        timestamptz NULL,
  eta_at               timestamptz NULL,       -- HOZIRGI BASHORAT
  delivered_at         timestamptz NULL,       -- FAKT

  -- Finance uchun: hisoblab boʻlmaydigan ikki fakt (Q9).
  payment_terms        text        NOT NULL DEFAULT 'net30',
  invoice_paid_at      timestamptz NULL,
  -- [{ "label": "Detention 2h", "amountUsd": 100 }]
  -- Ataylab jsonb: faqat yuk bilan birga oʻqiladi, alohida qidirilmaydi.
  -- Tahrirlanadigan boʻlsa — load_accessorials jadvaliga ajratiladi.
  accessorials         jsonb       NOT NULL DEFAULT '[]'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT loads_id_format      CHECK (id ~ '^[0-9]{4,6}$'),
  CONSTRAINT loads_state_codes    CHECK (origin_state ~ '^[A-Z]{2}$' AND destination_state ~ '^[A-Z]{2}$'),
  CONSTRAINT loads_not_same_place CHECK (origin_city <> destination_city OR origin_state <> destination_state),
  CONSTRAINT loads_broker_len     CHECK (char_length(broker) BETWEEN 2 AND 120),
  -- Bozor chegaralari. Ochiq-masalalar #3c: hozirgi mockda #4471 = $6.56/mi.
  -- Bu CHECK uni takrorlanishiga yoʻl qoʻymaydi.
  CONSTRAINT loads_rate_range     CHECK (rate_usd    BETWEEN 100 AND 20000),
  CONSTRAINT loads_distance       CHECK (distance_mi BETWEEN 25  AND 3500),
  CONSTRAINT loads_rpm_band       CHECK (rate_usd BETWEEN distance_mi * 1 AND distance_mi * 5),
  -- Federal brutto chegarasi 80,000 lbs; trailer yuki ~45,000 lbs.
  CONSTRAINT loads_weight         CHECK (weight_lbs BETWEEN 500 AND 45000),
  CONSTRAINT loads_equipment      CHECK (equipment_type IN
    ('dry-van','reefer','flatbed','step-deck','tanker','power-only')),
  CONSTRAINT loads_equip_length   CHECK (equipment_length_ft IN (28,42,45,48,53)),
  CONSTRAINT loads_status_valid   CHECK (status IN ('ontime','warn','crit','neutral','done')),

  CONSTRAINT loads_time_order     CHECK (booked_at <= pickup_at AND pickup_at < delivery_at),
  CONSTRAINT loads_dispatch_order CHECK (dispatched_at IS NULL OR dispatched_at >= booked_at),
  -- "Yetkazildi" va "yetkazilgan vaqt" — bir-birisiz boʻlmaydi. Ikki tomonlama.
  CONSTRAINT loads_done_iff_time  CHECK ((status = 'done') = (delivered_at IS NOT NULL)),
  -- 'neutral' = hali dispatch qilinmagan: haydovchi ham, truck ham yoʻq.
  CONSTRAINT loads_pending_clean  CHECK (status <> 'neutral' OR (driver_id IS NULL AND truck_id IS NULL AND dispatched_at IS NULL)),
  -- Yetkazilmagan yuk uchun hisob-faktura toʻlanmaydi.
  CONSTRAINT loads_paid_after_del CHECK (invoice_paid_at IS NULL OR
                                        (delivered_at IS NOT NULL AND invoice_paid_at >= delivered_at)),
  CONSTRAINT loads_terms_valid    CHECK (payment_terms IN ('net30','net15','quickpay')),
  CONSTRAINT loads_accessorials   CHECK (jsonb_typeof(accessorials) = 'array')
);

CREATE INDEX IF NOT EXISTS loads_status_idx    ON loads (status);
CREATE INDEX IF NOT EXISTS loads_driver_idx    ON loads (driver_id);
CREATE INDEX IF NOT EXISTS loads_pickup_idx    ON loads (pickup_at DESC);
CREATE INDEX IF NOT EXISTS loads_broker_idx    ON loads (broker);
CREATE INDEX IF NOT EXISTS loads_delivered_idx ON loads (delivered_at DESC) WHERE delivered_at IS NOT NULL;

-- Bir haydovchida bir vaqtda faqat BITTA tugallanmagan yuk.
-- Shu tufayli mockdagi `drivers[].currentLoad` bir qiymatli hisoblanadi —
-- va ikkita faol yuk biriktirish bazada imkonsiz boʻladi.
CREATE UNIQUE INDEX IF NOT EXISTS loads_one_active_per_driver_idx
  ON loads (driver_id) WHERE driver_id IS NOT NULL AND status <> 'done';

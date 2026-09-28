-- 045: pre-trip inspection -- 49 CFR 392.7 (ko'rik) va 396.13 (oxirgi
-- hisobotni o'qish).
--
-- DVIR (040) REYS OXIRIDA yozilgan HUJJAT: 396.11 hisobot talab qiladi,
-- nosozlik bo'lmasa ham. Pre-trip esa REYS BOSHIDAGI HARAKAT: chiqayotgan
-- haydovchi 392.7'ning 11 bandini ko'radi va NOSOZLIK TOPILSA yozma
-- yozuv talab qilinadi. Shu sababli bu dvir_reports'ning `kind` ustuni
-- emas -- bittasi hujjat, ikkinchisi harakat, va qonunda ikki xil joyda
-- turadi (392.7 / 396.11).
--
-- Uchta asl fakt shu jadvalda yashaydi:
--   1) 392.7 ko'rigi -- 11 band (DVIR_ITEMS + qo'l tormozi + g'ildirak/
--      obod, qarang constants/preTrip.js Q4), har biri TRUE/FALSE;
--   2) 396.13(b)(1) -- oxirgi DVIR o'qildi: reviewed_dvir_id shu o'qishning
--      isboti (NULL -- truck'ning hech qanday hisoboti yo'q, yangi
--      sotib olingan truck; 396.13 o'qiganidan hech narsa so'ramaydi);
--   3) topilgan nosozliklar -- defects jsonb, DVIR'ning lug'ati bilan
--      ([{ item, detail }] -- item PRE_TRIP_ITEM_KEYS'dan).
--
-- Yozuvchi BITTA: dispatch tranzaksiyasi (planAndSaveStops), ko'rik
-- natijasi constants/preTrip.js'ning inspectionOutcome'idan qaytariladi
-- -- DVIR'ning seedReport naqshi: sof hisob, truck holatidan, tasodif
-- faqat mustaqil kichik bandlarda, rng load id'dan seed. Re-dispatch
-- takror yozmasin: unique index (truck_id, load_id) -- eslab qolish emas,
-- cheklov.

CREATE TABLE IF NOT EXISTS pre_trip_inspections (
  id         bigserial   PRIMARY KEY,

  truck_id   text        NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  -- Ko'rikni KIM qildi va qaysi yuk uchun. Load CASCADE: yuk bekor
  -- qilinsa, uning ko'rigi ham bekor -- kompaniya reset'ining o'zi.
  driver_id  text        NULL REFERENCES drivers(id) ON DELETE SET NULL,
  load_id    text        NULL REFERENCES loads(id)   ON DELETE CASCADE,

  -- Ko'rik paytidagi odometer -- DVIR'ning o'qishiga qarshi solishtirish
  -- uchun (396.13: haydovchi oxirgi hisobotni O'QIYDI).
  odometer_mi integer    NOT NULL,

  -- 392.7 ro'yxati: DVIR_ITEMS (396.11 yadrosi) + qo'l tormozi (393.41)
  -- + g'ildirak va obod (393.205). Har biri TRUE (ko'rildi, yaxshi) yoki
  -- FALSE (nosozlik topildi) -- NULL yo'q, "ko'rilmadi" ko'rik emas.
  brakes_ok          boolean NOT NULL,
  lights_ok          boolean NOT NULL,
  tires_ok           boolean NOT NULL,
  steering_ok        boolean NOT NULL,
  coupling_ok        boolean NOT NULL,
  horn_ok            boolean NOT NULL,
  wipers_ok          boolean NOT NULL,
  mirrors_ok         boolean NOT NULL,
  emergency_eq_ok    boolean NOT NULL,
  parking_brake_ok   boolean NOT NULL,
  wheels_rims_ok     boolean NOT NULL,

  -- Topilgan nosozliklar (392.7 yozma yozuv talab qilganda). Bo'sh massiv
  -- ham fakt -- toza ko'rik. Lug'at DVIR'ning o'zi: [{ item, detail }].
  defects            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT pre_trip_defects_array CHECK (jsonb_typeof(defects) = 'array'),

  -- 396.13(b)(1): ko'rikdan OLDIN oxirgi hisobot o'qildi. Hisobot
  -- o'chsa (hech qachon o'chmasa-da: reset CASCADE qiladi), ko'rik tarixi
  -- uning yo'qolishini yolg'on aytmasin -- SET NULL.
  reviewed_dvir_id   bigint  NULL REFERENCES dvir_reports(id) ON DELETE SET NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pre_trip_odometer CHECK (odometer_mi >= 0),
  -- Bir yuk uchun bitta ko'rik: re-dispatch takror qator yozmasin.
  CONSTRAINT pre_trip_one_per_load UNIQUE (load_id)
);

-- "Shu truck'ning so'nggi ko'riklari" -- FleetDvir jadvali va
-- dispatchCheck'ning oxirgi holatini o'qigan read'lari uchun.
CREATE INDEX IF NOT EXISTS idx_pre_trip_truck_recent
  ON pre_trip_inspections (truck_id, created_at DESC);

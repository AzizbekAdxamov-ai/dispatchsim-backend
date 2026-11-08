-- 073: 1 sim kun = 30 real daqiqa (Azizbek qarori 2026-11-08). Avval 2 daqiqa edi.
--
-- Muammo: sim_day() (033) 120 soniyani qo'lda ichiga yozgan. Kun uzunligi
-- 1800 soniyaga o'tganda formulani shunchaki almashtirish HAR BIR eski sanani
-- siljitadi: truck_daily_metrics.day, last_service_date va h.k. eski (120s)
-- shkalada yozilgan, yangi formula ularni epoxadan boshlab 1800s qadam bilan
-- hisoblab, "bugun"ni o'tmishga tortib qo'yardi (sim_today() minglab kun
-- orqaga qaytardi).
--
-- Yechim: ANCHOR. Migratsiya bajarilgan paytdagi KEYINGI eski-formula kun
-- chegarasi (at) va o'sha chegaradagi eski sim kun raqami (day) sim_state
-- ga yoziladi. sim_day():
--   * ts < at  -> eski formula (120s), tarix o'zgarmaydi
--   * ts >= at -> day + floor((ts - at) / 1800)  -- yangi shkala, sana uzluksiz
--   * anchor yo'q, yoki anchor epoxadan OLDIN (reset-company yangi epoxa
--     yozgan) -> epoxadan boshlab sof 1800s formula.
--
-- PUL KUTISHLARI O'ZGARMAYDI: invoice_due_at va driver_settlements.due_at
-- 120s/kun (FINANCE_REAL_SEC_PER_SIM_DAY) da qoladi -- ularni siljitmaymiz.
--
-- JS tomoni: src/constants/simClock.js (REAL_SEC_PER_SIM_DAY = 1800,
-- FINANCE_REAL_SEC_PER_SIM_DAY = 120, SIM_CLOCK_RESCALE_RATIO = 15).
-- test/simClock30.test.js shu fayldagi sonlarni konstantalarga solishtiradi.

-- ---------------------------------------------------------------------
-- 1. Anchor (epoxa bo'lmasa -- yangi baza -- kerak emas)
-- ---------------------------------------------------------------------
INSERT INTO sim_state (key, value)
SELECT 'sim_clock_rescale',
       jsonb_build_object(
         'at',  to_char(b.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'day', to_char(b.day, 'YYYY-MM-DD')
       )
  FROM (
    SELECT e.epoch
             + (floor(EXTRACT(EPOCH FROM (now() - e.epoch)) / 120.0) + 1) * 120 * interval '1 second' AS at,   -- 120 = ESKI sim kun (soniya)
           (e.epoch AT TIME ZONE 'UTC')::date
             + (floor(EXTRACT(EPOCH FROM (now() - e.epoch)) / 120.0) + 1)::int AS day
      FROM (SELECT sim_epoch() AS epoch) e
     WHERE e.epoch IS NOT NULL
  ) b
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. sim_day() va sim_day_start()
-- ---------------------------------------------------------------------
-- STABLE (IMMUTABLE emas): sim_epoch() va sim_state jadvallarni o'qiydi.
CREATE OR REPLACE FUNCTION sim_day(ts timestamptz) RETURNS date
AS $$
  SELECT CASE
           WHEN e.epoch IS NULL THEN NULL
           WHEN a.at IS NULL OR a.at <= e.epoch          -- yangi shkala, to'liq
             THEN (e.epoch AT TIME ZONE 'UTC')::date
                  + floor(EXTRACT(EPOCH FROM (ts - e.epoch)) / 1800.0)::int   -- 1800 = YANGI sim kun (soniya)
           WHEN ts < a.at                                -- anchordan oldin: eski
             THEN (e.epoch AT TIME ZONE 'UTC')::date
                  + floor(EXTRACT(EPOCH FROM (ts - e.epoch)) / 120.0)::int    -- 120 = ESKI sim kun (soniya)
           ELSE a.day + floor(EXTRACT(EPOCH FROM (ts - a.at)) / 1800.0)::int
         END
    FROM (SELECT sim_epoch() AS epoch) e
    LEFT JOIN (
      SELECT (value->>'at')::timestamptz AS at, (value->>'day')::date AS day
        FROM sim_state WHERE key = 'sim_clock_rescale'
    ) a ON true
$$ LANGUAGE sql STABLE;

-- ts ttushadigan sim kunning boshlanish momenti. sim_day() bilan bir xil qoidalar.
CREATE OR REPLACE FUNCTION sim_day_start(ts timestamptz) RETURNS timestamptz
AS $$
  SELECT CASE
           WHEN e.epoch IS NULL THEN NULL
           WHEN a.at IS NULL OR a.at <= e.epoch
             THEN e.epoch + floor(EXTRACT(EPOCH FROM (ts - e.epoch)) / 1800.0) * 1800 * interval '1 second'
           WHEN ts < a.at
             THEN e.epoch + floor(EXTRACT(EPOCH FROM (ts - e.epoch)) / 120.0) * 120 * interval '1 second'
           ELSE a.at + floor(EXTRACT(EPOCH FROM (ts - a.at)) / 1800.0) * 1800 * interval '1 second'
         END
    FROM (SELECT sim_epoch() AS epoch) e
    LEFT JOIN (
      SELECT (value->>'at')::timestamptz AS at
        FROM sim_state WHERE key = 'sim_clock_rescale'
    ) a ON true
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- 3. Driver qualification sanalari: sim-kun hisobi saqlansin
-- ---------------------------------------------------------------------
-- Bu sanalar to'liq momentlar (043) va o'quvchi ularni REAL_MS_PER_SIM_DAY
-- bilan sim kunga aylantiradi. Kun 15 baravar uzaydi, shuning uchun "hozirdan
-- masofa" 15 ga ko'paytiriladi -- qolgan sim kunlar soni o'zgarmaydi.
-- Faqat eski-shkalali oynalar ichidagi qiymatlar: real-kalendar sanalar
-- (minglab kun uzoqda) tegilmaydi.
DO $$
DECLARE
  ratio         constant int := 15;        -- SIM_CLOCK_RESCALE_RATIO = 1800 / 120
  old_day_sec   constant int := 120;       -- ESKI sim kun (soniya)
  medical_days  constant int := 1000;      -- medical: hozirdan keyingi oyna (sim kun)
  mvr_days      constant int := 365;       -- MVR yillik oyna (391.25), sim kun
  license_days  constant int := 1400;      -- CDL: hozirdan keyingi oyna (sim kun)
BEGIN
  UPDATE driver_qualification
     SET medical_expires_on = now() + (medical_expires_on - now()) * ratio
   WHERE medical_expires_on > now()
     AND medical_expires_on <= now() + medical_days * old_day_sec * interval '1 second';

  UPDATE driver_qualification
     SET mvr_checked_on = now() - (now() - mvr_checked_on) * ratio
   WHERE mvr_checked_on <= now()
     AND mvr_checked_on > now() - mvr_days * old_day_sec * interval '1 second';

  UPDATE drivers
     SET license_expires_on = now() + (license_expires_on - now()) * ratio
   WHERE license_expires_on > now()
     AND license_expires_on <= now() + license_days * old_day_sec * interval '1 second';
END $$;

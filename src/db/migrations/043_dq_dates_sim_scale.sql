-- 043: DQ hujjat sanalari SIM shkalada yashashi kerak.
--
-- Reader (compliance.service.js readDocumentStatus/daysUntil) har bir
-- sanani simulatsiya kalendari bo'yicha o'lchaydi: kun farqi
-- REAL_MS_PER_SIM_DAY ga bo'linadi (2 real daqiqa = 1 sim kun). Ustunlar
-- esa DATE edi -- DATE'ga yozilgan qiymat o'sha kunning 00:00 UTC
-- momentiga yopishadi, va o'qishda shu yopilish yarim sim kundan
-- KATTA shovqin beradi: "bugun" tekshirilgan MVR (-- 1 real kun) -720
-- sim kun eskirgan bo'lib chiqadi, har kim MVR 'expired'.
--
-- Ikki tomon bir xil xatoni ikki marta berdi (2026-09-25 jonli
-- tekshiruv): seed generatori (build.js buildDqRow) real-shkala ofsetlar
-- yozgan edi, fixture testlari esa "now() - interval '30 days'" bilan
-- yozib, -10 800 sim kunlik MVR olishgan edi. Ikkalasi ham ustunning
-- DATE ekaniga suyandi. timestamptz -- bu yopilish yo'q, generator
-- to'liq moment yozadi, reader o'lchaydigan shkalada.
--
-- Mavjud qatorlar: date -> timestamptz konversiyasi 00:00 UTC'ni
-- saqlaydi (medical kelajakda -- xavfsiz), lekin MVR 'tekshirilgan'
-- sanalari hali ham minglab sim kun eskirgan bo'lib qoladi -- ular
-- sim-shkalaga deterministik cho'ziladi (har bir qatorga 20..330 sim
-- kun oralig'idan, 391.25'ning yillik oynasi ichida).

ALTER TABLE driver_qualification
  ALTER COLUMN medical_expires_on TYPE timestamptz,
  ALTER COLUMN mvr_checked_on     TYPE timestamptz;

ALTER TABLE drivers
  ALTER COLUMN license_expires_on TYPE timestamptz;

WITH r AS (
  SELECT driver_id, (row_number() OVER (ORDER BY driver_id) * 137 % 311 + 20) AS days
    FROM driver_qualification
)
UPDATE driver_qualification dq
   SET mvr_checked_on = now() - make_interval(secs => r.days * 120)  -- 120s = 1 sim kun (032)
  FROM r
 WHERE r.driver_id = dq.driver_id;

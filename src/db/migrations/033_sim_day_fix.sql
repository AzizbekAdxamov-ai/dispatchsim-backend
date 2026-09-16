-- 033: sim_day() hech qachon kun qo'shmagan — tuzatish.
--
-- 032 ning bucket formulasi bucket'ni 120 SONIYA sifatida qo'shdi, kun
-- sifatida emas:
--
--   epoch + bucket * interval '120 seconds'
--
-- bucket = elapsed::bigint / 120 allaqachon "nechanchi 120-soniyalik oyna"
-- ekanini bildiradi (ya'ni sim kun raqami). Uni qayta 120 soniyaga
-- ko'paytirish elapsed'ni faqat 120 soniyagacha kesib, deyarli ts'ning
-- o'ziga qaytaradi — natijada ::date ts'ning REAL kalendar sanasi bo'lib
-- chiqadi, sim kuni emas. sim_today() shu sababli amalda current_date bilan
-- bir xil edi va 032 ning butun maqsadi — har bir sim kun o'z sanasiga ega
-- bo'lishi (Q1) — bajarilmagan edi.
--
-- To'g'ri formula: bucket sim KUN sifatida epoxaning sanasiga qo'shiladi,
-- 120 soniya sifatida emas.
--
-- Ikki nozik joy:
--
-- 1. floor(), bigint / 120 emas. PostgreSQL'da butun sonlarni bo'lish
--    nolga tomon kesadi, pastga emas. epoxadan OLDINGI ts uchun (masalan
--    seed yozgan eski cash_ledger qatori) elapsed manfiy bo'ladi:
--    bigint / 120 uni nolga yaqinlashtirib kesadi (masalan -1/120 = 0),
--    floor esa pastga kesadi (-1/120.0 -> -0.0083 -> floor -1). Manfiy
--    tomonda ikkisi bir kunga farq qiladi — floor to'g'risi, chunki epoxadan
--    bir soniya oldingi ts hali ham "bir kun oldin", "shu kun" emas.
--
-- 2. 120 — REAL_MS_PER_SIM_DAY / 1000 (src/constants/simClock.js dagi
--    REAL_MS_PER_SIM_DAY = 120000). SQL JS faylni import qila olmaydi,
--    shuning uchun bu son shu yerda qo'lda takrorlangan. scripts/
--    sim-clock-check.js ikkisining kelishib turishini bazaga qarab
--    tekshiradi — u yerdagi 120 esa REAL_MS_PER_SIM_DAY'dan hisoblanadi,
--    qo'lda yozilmaydi.
CREATE OR REPLACE FUNCTION sim_day(ts timestamptz) RETURNS date
AS $$
  SELECT (sim_epoch() AT TIME ZONE 'UTC')::date
       + floor(EXTRACT(EPOCH FROM (ts - sim_epoch())) / 120.0)::int
$$ LANGUAGE sql STABLE;

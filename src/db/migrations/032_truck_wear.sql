-- 032: truck ishlatilgani sayin o'zgaradi — poydevor.
--
-- Bu migratsiya hech qanday jadval qo'shmaydi. U to'rtta shartni hal qiladi,
-- ularsiz tick'ning truckka qaytib yozishi ishlamaydi yoki noto'g'ri ishlaydi.

-- ---------------------------------------------------------------------
-- 1. Siqilgan taqvimning o'zi SQL'da yashaydi
-- ---------------------------------------------------------------------
--
-- src/constants/simClock.js bir sim kunni 120 real soniya deb belgilaydi
-- (REAL_MS_PER_SIM_DAY = 120000). truck_daily_metrics.day va
-- maintenance_records.due_date DATE ustunlar — real kalendarda bir seansning
-- hamma yozuvi bitta sanaga tushadi va PK to'qnashadi. Shuning uchun har
-- bir sim kun o'z sanasiga ega bo'lishi kerak, epoxa esa kompaniya
-- qachon ochilgan bo'lsa — cash_ledger'dagi kind='opening' qatori, aynan
-- o'sha nuqtadan foiz soati ham boshlangan (021).
--
-- sim_day(ts): ts qaysi sim kunga tushishini DATE sifatida qaytaradi. Kun
-- chegarasi UTC bo'yicha: 120 soniyalik oynalar UTC kechasi orqali yotadi va
-- seed generatori ham UTC'da sana yozadi (toDateOnly). NATIJADA bir funksiya
-- turli server vaqt zonalari bir xil kunlarni ko'radi.
--
-- sim_day() STABLE, IMMUTABLE emas: sim_epoch() jadvalni o'qiydi, va IMMUTABLE
-- deb e'lon qilingan funksiya indeks ifodasida ishlatilishi mumkin bo'lib,
-- u yerda har so'rovda qayta hisoblanmasdan qotib qolishi mumkin. Hech qaysi
-- indeks shu funksiyalarga tayanmaydi — ular faqat WHERE va SELECT ichida
-- ishlatiladi.
CREATE OR REPLACE FUNCTION sim_epoch() RETURNS timestamptz
AS $$
  SELECT occurred_at FROM cash_ledger WHERE kind = 'opening' ORDER BY id LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sim_day(ts timestamptz) RETURNS date
AS $$
  SELECT (
    sim_epoch()
    + ((EXTRACT(EPOCH FROM (ts - sim_epoch()))::bigint / 120) * interval '120 seconds')
  ) AT TIME ZONE 'UTC'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sim_today() RETURNS date
AS $$ SELECT sim_day(now()) $$
LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- 2. Bir truck, bir xizmat, bir muddat — bitta yozuv
-- ---------------------------------------------------------------------
--
-- Tick har daqiqada ishlaydi va odometr karralisini kesib o'tgan har yugurishda
-- 'due' yozuv ochadi. ON CONFLICT bu yozuvni himoya qiladi — lekin ON CONFLICT
-- ishonchli bo'lishi uchun unikal indeks bazada bo'lishi SHART. Hozirgi
-- maint_status_due_idx oddiy indeks, u ikkita bir xil yozuvning paydo
-- bo'lishiga to'sqinlik qilmaydi.
--
-- Qisman indeks: due_mileage bo'lmagan yozuvlar (seed'dagi scheduled/done
-- tarix) bu qoidadan tashqarida — ular odometr bilan bog'liq emas.
CREATE UNIQUE INDEX IF NOT EXISTS maint_one_per_truck_service_mileage
  ON maintenance_records (truck_id, service, due_mileage)
  WHERE due_mileage IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Kassa daftariga 'maintenance' turi
-- ---------------------------------------------------------------------
--
-- Xizmat puli 'fuel' yoki 'road_event' deb yozilsa — xarajat hisobotlari
-- noto'g'ri bo'ladi. To'liq ro'yxat 029'dan ko'chiriladi (027 xatosi
-- takrorlanmasin: u CHECK'ni qayta yozib, oldingi turdoshlardan birini
-- o'chirib qo'ygan edi).
ALTER TABLE cash_ledger DROP CONSTRAINT IF EXISTS ledger_kind;
ALTER TABLE cash_ledger ADD CONSTRAINT ledger_kind CHECK (kind IN (
  'opening',
  'truck_purchase',
  'driver_onboarding',
  'fuel',
  'load_payment',
  'settlement',
  'insurance',
  'interest',
  'adjustment',
  'road_event',
  'maintenance'
));

-- ---------------------------------------------------------------------
-- 4. Yoqilg'i: yuk uchun bir marta, bak to'ldirish erkin
-- ---------------------------------------------------------------------
--
-- cash_ledger_once_per_ref (kind, ref_type, ref_id) ustida edi va ro'yxatida
-- 'fuel' turibdi. Ikkita muammo:
--
-- Birinchisi: bak to'ldirish ham kind='fuel' — lekin uning ref_type/ref_id
-- yo'q. NULL'lar unique indeksda bir-biriga to'qnashmaydi, ya'ni 'fuel'
-- ro'yxatda turgan holda ham to'ldirishni ushlab turmagan edi — ro'yxat
-- yolg'on hujjat edi.
--
-- Ikkinchisi: bak to'ldirish kelajakda ref_type='truck', ref_id=truckId bilan
-- yozilsa, ikkinchi to'ldirish ('fuel','truck',truckId) da to'qnashib, rad
-- etilardi — bak to'ldirish takrorlanadigan amal, bir marta emas.
--
-- Shuning uchun 'fuel' keng indeksdan chiqariladi va yuk yoqilg'isi uchun
-- tor indeks qo'shiladi: bir yuk uchun bitta fuel qatori — tick retry ikki
-- marta yozmasin. Qolgan turlar o'z himoyasida qoladi.
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_fuel_once_per_load
  ON cash_ledger (ref_id)
  WHERE kind = 'fuel' AND ref_type = 'load';

DROP INDEX IF EXISTS cash_ledger_once_per_ref;
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_once_per_ref
  ON cash_ledger (kind, ref_type, ref_id)
  WHERE kind IN ('truck_purchase', 'driver_onboarding', 'load_payment', 'settlement');

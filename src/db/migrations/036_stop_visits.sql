-- 036: to'xtashlar ishlaydi -- haydovchi endi yo'lda haqiqatan to'xtaydi.
--
-- 035 facilities jadvalini va joylashuv hisobini yozdi, lekin hech narsa
-- undan foydalanmasdi: shoxobchalar bazada yotardi, birorta ham yuk
-- ularning yonidan "to'xtamasdan" o'tib ketardi. Bu migratsiya faqat
-- shu bo'sh joyni yopadi -- bitta jadval, stop_visits: bir yuk bitta
-- shoxobchada qachon to'xtagani, nega (dam/yoqilg'i), va pul qachon
-- chiqqani.
--
-- Loyihaning asosiy qarori shu yerda ham amal qiladi: truck uzluksiz
-- simulyatsiya qilinmaydi (src/modules/tracking/position.js), shuning
-- uchun to'xtashlar TICKDA emas, DISPATCH paytida bir marta hisoblanadi
-- (src/modules/facilities/stopPlan.js) va bu jadvalga yoziladi. Tick esa
-- faqat allaqachon "yetib kelgan" (arrived_at <= now()) tashriflar uchun
-- pul chiqaradi (dispatch.service.js'ning settleArrivedStops()) -- xuddi
-- deliverArrivedLoads/payDueInvoices qanday ishlasa, shunday: bitta
-- tranzaksiya bitta qator, FOR UPDATE SKIP LOCKED bilan.

CREATE TABLE IF NOT EXISTS stop_visits (
  id                 bigserial   PRIMARY KEY,

  -- Load o'chsa, uning to'xtash tarixi ham ma'nosiz -- load_events (027)
  -- bilan bir xil naqsh.
  load_id            text        NOT NULL REFERENCES loads(id) ON DELETE CASCADE,

  -- Dispatch paytida load_id'da ALLAQACHON truck_id/driver_id bor --
  -- shu yerda ham saqlanadi, chunki tick (settleArrivedStops) va
  -- tracking o'qishlari har safar loads'ga JOIN qilmasdan to'g'ridan
  -- to'g'ri qaysi truck/driver ekanini bilishi kerak. Load bekor
  -- qilinsa ham (cancelDispatch) truck_id/driver_id load'dan tozalanadi,
  -- lekin bu yozuv -- tarixiy fakt -- o'zgarmaydi; faqat truck yoki
  -- driver butunlay o'chirilsa (kompaniya reset) shu qator ham ketadi.
  truck_id           text        NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  driver_id          text        NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,

  -- Dunyoning o'zi (035'dagi kabi) -- KEEP ro'yxatida, shuning uchun
  -- ON DELETE yo'q: bir facility hech qachon o'chirilmaydi.
  facility_id        text        NOT NULL REFERENCES facilities(id),

  reason             text        NOT NULL,

  -- Yo'l boshidan necha milda -- MASOFA bo'yicha (stopPlan.js
  -- facility'ni marshrut geometriyasiga proyeksiya qiladi), indeks
  -- bo'yicha emas. position.js buni xuddi eventOpenedAt kabi ishlatadi:
  -- shu oynada f = route_offset_mi / distance_mi ga muzlaydi.
  route_offset_mi    integer     NOT NULL,

  arrived_at         timestamptz NOT NULL,
  departed_at        timestamptz NOT NULL,

  -- Faqat reason='fuel' uchun -- stop_visits_fuel_fields pastda buni
  -- majburlaydi (035'dagi facilities_fuel_price bilan bir xil naqsh).
  gallons            integer     NULL,
  cost_usd           integer     NULL,

  -- NULL = hali pul chiqmagan. Tick shartli UPDATE bilan belgilaydi
  -- (WHERE settled_at IS NULL) -- ikki marta ishlasa ham ikki marta
  -- to'lamaydi. Faqat 'fuel' uchun ma'noli (dam olish pulga tegmaydi).
  settled_at         timestamptz NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stop_visits_reason CHECK (reason IN ('rest', 'fuel')),
  CONSTRAINT stop_visits_offset_nonneg CHECK (route_offset_mi >= 0),
  CONSTRAINT stop_visits_departed_after CHECK (departed_at > arrived_at),

  -- 'fuel' -- gallon va narx bo'lishi SHART; 'rest' -- ikkalasi ham NULL
  -- bo'lishi shart. facilities_fuel_price (035) bilan aynan bir xil
  -- shakl: bir fakt hech kim atayin yaratmagan holatni CHECK ushlaydi.
  CONSTRAINT stop_visits_fuel_fields CHECK (
    (reason = 'fuel' AND gallons IS NOT NULL AND gallons > 0
       AND cost_usd IS NOT NULL AND cost_usd >= 0)
    OR
    (reason = 'rest' AND gallons IS NULL AND cost_usd IS NULL)
  ),

  -- Hisob-kitob faqat 'fuel' uchun ma'noli -- dam olish uchun settled_at
  -- yozilsa, bu hech kim atayin qilmagan yozuv.
  CONSTRAINT stop_visits_settled_only_fuel CHECK (
    settled_at IS NULL OR reason = 'fuel'
  ),

  -- Bir yuk bitta nuqtada bir marta -- CHEGARA bu ishni qiladi, eslab
  -- qolish emas (034/035'dagi bir xil qoida). Qayta dispatch (yoki tick
  -- ikki marta) ON CONFLICT DO NOTHING bilan takroriy qator yaratmaydi.
  -- Bir xil offsetda ikkita XILDAGI to'xtash (fuel + rest birlashgan
  -- holat, stopPlan.js) ataylab ruxsat etiladi -- reason ustuni ularni
  -- ajratadi.
  CONSTRAINT stop_visits_unique UNIQUE (load_id, route_offset_mi, reason)
);

CREATE INDEX IF NOT EXISTS idx_stop_visits_load ON stop_visits (load_id);
CREATE INDEX IF NOT EXISTS idx_stop_visits_truck ON stop_visits (truck_id);

-- Tick'ning claimArrivedFuelVisits'i shu shartni so'raydi: hali
-- hisoblanmagan, allaqachon yetib kelgan yoqilg'i tashriflari.
CREATE INDEX IF NOT EXISTS idx_stop_visits_unsettled_fuel
  ON stop_visits (arrived_at)
  WHERE reason = 'fuel' AND settled_at IS NULL;

-- Tracking'ning "hozir shu yerda to'xtagan" so'rovi: bitta load uchun
-- ochiq oyna (arrived_at <= now() < departed_at). load_events_one_open
-- (027) o'ziga tegishli "ochiq hodisa bormi" so'rovi uchun xuddi shunday
-- indekslangan edi.
CREATE INDEX IF NOT EXISTS idx_stop_visits_window
  ON stop_visits (load_id, arrived_at, departed_at);

-- Tick har bir yoqilg'i tashrifi uchun pulni AYNAN BIR MARTA chiqaradi.
-- cash_ledger_fuel_once_per_load (032) bilan bir xil naqsh: keng
-- cash_ledger_once_per_ref 'fuel'ni o'z ichiga olmaydi (032'ning o'zi
-- buni tushuntiradi -- bak to'ldirish ref_type/ref_id'siz bo'lgani
-- uchun), shuning uchun har bir YANGI ref_type'ning o'z tor indeksi
-- kerak. ref_type='stop_visit' uni load yetib kelgandagi yoqilg'i
-- to'lovidan (ref_type='load', 032) mustaqil qiladi.
CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_stop_fuel_once_per_visit
  ON cash_ledger (ref_id)
  WHERE kind = 'fuel' AND ref_type = 'stop_visit';

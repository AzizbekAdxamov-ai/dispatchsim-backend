-- 039: haydovchining malaka fayli (Driver Qualification File) -- 49 CFR 391
-- talab qiladigan hujjatlar holati bitta jadvalda.
--
-- Samsara tomonda bu "Driver Qualification" ekrani; FMCSA tomonda esa
-- Motor Carrier Safety Planner'ning DQ checklist'i: CDL, medical
-- certificate, MVR, drug & alcohol program. Simulatorda ular endi jadval --
-- chunki "Haydovchini yukka biriktirish mumkinmi?" degan savolning javobi
-- faqat shu faktlardan chiqadi, va ularning muddati oziq-ovqat kabi qaraydi:
-- har bir hujjat amal qilish muddatiga ega, muddati o'tayotgan yoki o'tgan
-- hujjat -- compliance ekranida sariq yoki qizil qator.
--
-- Loyihaning mavjud naqshi shu yerda davom etadi: license_expires_on
-- (005) allaqachon drivers jadvalida bor edi va DriverCard'da ko'rinadi --
-- bu jadval shu g'oyani butun DQ faylga kengaytiradi. CHECK cheklovlari
-- ma'lumotni noto'g'ri bo'lishidan emas, MA'NOSIZ bo'lishidan qo'riqlaydi
-- (status lug'ati yopiq, sanalar null yoki haqiqiy sana).

CREATE TABLE IF NOT EXISTS driver_qualification (
  driver_id  text PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,

  -- CDL: klass drivers.cdl_class'da yashaydi; bu yerda faqat holati.
  cdl_status           text NOT NULL DEFAULT 'valid'
                       CONSTRAINT dq_cdl_status CHECK (cdl_status IN ('valid','expiring','expired','suspended')),

  -- DOT medical certificate (49 CFR 391.43). Expiry nullable -- hali
  -- o'tkazilmagan tekshiruv ham haqiqiy holat.
  medical_expires_on   date NULL,
  medical_status       text NOT NULL DEFAULT 'valid'
                       CONSTRAINT dq_medical_status CHECK (medical_status IN ('valid','expiring','expired','missing')),

  -- Motor Vehicle Record: yillik pull (49 CFR 391.25).
  mvr_checked_on       date NULL,
  mvr_violations       integer NOT NULL DEFAULT 0 CONSTRAINT dq_mvr_nonneg CHECK (mvr_violations >= 0),
  mvr_status           text NOT NULL DEFAULT 'valid'
                       CONSTRAINT dq_mvr_status CHECK (mvr_status IN ('valid','expiring','expired')),

  -- Drug & alcohol consortium (49 CFR 382).
  da_status            text NOT NULL DEFAULT 'valid'
                       CONSTRAINT dq_da_status CHECK (da_status IN ('valid','expiring','expired','missing')),

  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- "Har ishlayotgan haydovchining DQ fayli bor" degan qoidani BAZA emas,
-- SEED + TEST qo'riqlaydi. Sabab ikkita:
--
-- 1) PostgreSQL CHECK ichida boshqa jadvalga subquery yozib bo'lmaydi
--    (CHECK immutabel bo'lishi shart).
-- 2) Trigger bilan bloklash HR hire oqimini BUZARDI: hozircha hujjat
--    to'plamaydigan yangi haydovchi hire paytida DQ qatorsiz keladi va
--    bu ekranda "Not on file" deb KO'RINADI -- bloklanmaydi. Bu loyihaning
--    "consequence over blocking" qoidasi: yetishmayotgan hujjat -- fakt,
--    uning o'zi dars; katta harakat (yuk biriktirish) to'silmaydi.
--
-- test/generated-data.test.js seed chiqishida HAR BIR haydovchi uchun DQ
-- qatori borligini assert qiladi -- shu yerning o'zi qo'riqchi.

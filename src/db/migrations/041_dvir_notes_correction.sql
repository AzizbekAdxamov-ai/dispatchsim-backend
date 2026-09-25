-- 041: DVIR (040) ikki tuzatish -- ikkalasi jonli tekshiruvda tick logidan
-- topildi ("[tick] delivery failed: dvir_defects_need_correction violation"
-- har 30 sekundda).
--
-- 1) dvir_defects_need_correction (040) TESKARI ishlagan. Yangi hisobot
--    tug'ilishida defects_corrected=false -- tuzatish majburiyati 396.11(a)
--    bo'yicha SHU holatdan tug'iladi: kamchilik yoziladi, hech kim hali
--    uni tuzatgani haqida gapirmaydi. Bayroq keyin, 396.13(b)(2)
--    tasdig'i bilan ko'tariladi. CHECK esa aynan shu normal tug'ilish
--    holatini taqiqlab, har qanday kamchilikli yetkazib berishni
--    tranzaksiyadan o'tkazmadi; "kamchilik bor, lekin allaqachon
--    tuzatilgan" degan yolg'on hisobot esa tasdig'siz o'tib ketdi.
--    To'g'ri juftlik: corrected=true kamchilik soni NOLDAN KATTA bo'lishini
--    va tasdiq yozuvining o'zini talab qiladi. (Toza hisobot hech qachon
--    certify qilinmaydi -- dvir.service.js xizmatda rad etadi, bazada
--    ushlab turish kerak emas.)
--
-- 2) Notalar (25--35% shina eskirigi, yo'ldagi ta'mirdan kuzatuv)
--    kamchilik EMAS -- model shunday qaror qilgan (dvir.test.js: "a note
--    is not a defect -- no correction owed"), lekin ular defects jsonb
--    ichiga yozilardi: truck'ni ushlab turmaydigan matn kamchilik
--    ro'yxatida yashardi. Notalar endi o'z ustunida -- ekranda ko'rinadi,
--    lekin 396.13 bilan bog'lanmaydi.

ALTER TABLE dvir_reports
  ADD COLUMN IF NOT EXISTS notes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE dvir_reports
  ADD CONSTRAINT dvir_notes_array CHECK (jsonb_typeof(notes) = 'array');

ALTER TABLE dvir_reports
  DROP CONSTRAINT IF EXISTS dvir_defects_need_correction;

ALTER TABLE dvir_reports
  ADD CONSTRAINT dvir_correction_certified CHECK (
    defects_corrected = false
      OR (jsonb_array_length(defects) > 0 AND certified_at IS NOT NULL)
  );

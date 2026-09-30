-- 044: izoh oynasi (4..60) yana MAJBURIY bo'ladi -- yozilgan har qanday
-- izoh uchun.
--
-- 042 to'g'ri muammoni yechdi: unidentified yozuv IZOHSIZ tug'iladi
-- (haydovchi tizimga kirmagan, aytadigan hech kim yo'q), shuning uchun
-- 038'ning "automatic'dan boshqa hammasida izoh bo'lsin" qoidasi
-- birinchi repositioning dispatch'ini o'ldirardi.
--
-- Lekin 042'ning yangi shakli izoh YOZILGANDA nima bo'lishini aytmay
-- qoldi: `(origin = 'unidentified' AND driver_id IS NULL)` shohi
-- qanoatlantirilgan bo'lsa, uchinchi shoh umuman tekshirilmaydi. Ya'ni
-- annotate oqimi unidentified qatorga 1 belgilik izoh yozsa, baza uni
-- qabul qilardi. Oyna faqat xizmat kodida qolgan edi -- bu loyihada
-- "eslab qolish bilan emas, cheklov bilan" qoidasining aynan buzilishi.
--
-- To'g'ri juftlik ikki holatga bo'linadi, ustma-ust tushmaydigan:
--   izoh YO'Q  -> yozuv automatic (haydovchisi bor) yoki unidentified
--                 (haydovchisi yo'q) bo'lishi shart;
--   izoh BOR   -> ELD oynasi, 4..60 belgi (49 CFR 395 Subpart B,
--                 Appendix A), kim yozganidan qat'i nazar.
--
-- 038'ning duty_events_annotation_max (<= 60) ortiqcha bo'lib qoladi,
-- lekin qoldiriladi: qo'llanilgan cheklovni olib tashlash uni
-- qayta yozish bilan teng, va u hech narsaga xalaqit bermaydi.

ALTER TABLE duty_events DROP CONSTRAINT duty_events_annotation_required;

ALTER TABLE duty_events ADD CONSTRAINT duty_events_annotation_required CHECK (
  (annotation IS NULL AND (
    (origin = 'automatic'    AND driver_id IS NOT NULL)
    OR (origin = 'unidentified' AND driver_id IS NULL)
  ))
  OR (annotation IS NOT NULL AND char_length(btrim(annotation)) BETWEEN 4 AND 60)
);

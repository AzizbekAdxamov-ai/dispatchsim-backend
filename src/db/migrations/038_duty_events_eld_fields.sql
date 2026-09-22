-- 038: duty_events (037) ELD qoidalariga ikki joyda moslashtiriladi.
--
-- 037 allaqachon qo'llanilgan bo'lishi mumkin -- uni tahrirlash
-- migrate.js'ning checksum'ini buzadi, shuning uchun o'zgarish shu yerda.
--
-- 1) Izoh uzunligi: 4..60 belgi.
--    037 faqat pastki chegarani (>= 4) qo'ygan edi. ELD texnik talablari
--    (49 CFR 395 Subpart B, Appendix A, "Comment/Annotation": kamida 4,
--    ko'pi bilan 60 belgi) va Samsara'ning Unassigned HOS oqimi ("Annotate
--    Selected ... max 60 characters",
--    https://kb.samsara.com/hc/en-us/articles/360043216412, 2026-09-21
--    o'qildi) ikkalasi ham 60 ni yuqori chegara deydi.
--
-- 2) Haydovchisiz (unidentified) yozuv.
--    ELD haydovchi tizimga kirmagan paytdagi haydashni ham yozadi --
--    "unidentified driving". Bunday yozuvning haydovchisi YO'Q; u truck'ga
--    tegishli, keyin carrier uni haydovchiga biriktiradi yoki izoh bilan
--    tushuntiradi (Compliance > Unassigned HOS). 037'da driver_id NOT NULL
--    edi -- bunday yozuvni saqlashning iloji yo'q edi. Endi: driver_id
--    faqat origin = 'unidentified' bo'lganda bo'sh bo'lishi mumkin, va u
--    holda truck_id majburiy (kimniki bo'lmasa ham, qaysi truck ekanligi
--    ma'lum bo'lishi shart).

ALTER TABLE duty_events DROP CONSTRAINT duty_events_annotation_required;
ALTER TABLE duty_events ADD CONSTRAINT duty_events_annotation_required CHECK (
  origin = 'automatic'
  OR (annotation IS NOT NULL AND char_length(btrim(annotation)) BETWEEN 4 AND 60)
);
ALTER TABLE duty_events ADD CONSTRAINT duty_events_annotation_max CHECK (
  annotation IS NULL OR char_length(annotation) <= 60
);

ALTER TABLE duty_events ALTER COLUMN driver_id DROP NOT NULL;
ALTER TABLE duty_events ADD CONSTRAINT duty_events_owner CHECK (
  driver_id IS NOT NULL
  OR (origin = 'unidentified' AND truck_id IS NOT NULL)
);

-- Haydovchisiz yozuvlar uchun ham "bir paytda bitta faol boshlanish" --
-- duty_events_one_active_start (037) driver_id NULL qatorlarni ushlamaydi
-- (NULL'lar UNIQUE'da bir-biriga teng emas), shuning uchun truck bo'yicha.
CREATE UNIQUE INDEX IF NOT EXISTS duty_events_one_active_unidentified_start
  ON duty_events (truck_id, started_at)
  WHERE record_status = 'active' AND driver_id IS NULL;

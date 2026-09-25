-- 042: duty_events_annotation_required (038) unidentified yozuvning
-- tug'ilishini ushlab qolgan edi.
--
-- Unidentified driving (49 CFR 395.32) hech kim imzo chekmagan paytdagi
-- haydash: haydovchi tizimga kirmagan -- shuning uchun YOZUV DA HISOBLAMA
-- YO'Q. Izoh keyin, carrier review qilganda yoziladi: assign (395.32(d))
-- yangi qatorga izoh bilan yozadi, annotate esa originalni saqlab,
-- izohini qo'shadi. 038'ning CHECK esa origin='automatic' dan boshqa
-- hammasidan BOSHLANISHIDA izoh talab qilib qo'ydi -- productionning
-- o'zi (dispatch.service.js -> insertUnidentified, izohsiz yozadi)
-- birinchi repositioning dispatch'ida CHECK violation bilan o'lib
-- qolardi. Jonli tekshiruvda test fixturesi shu to'qqizni topdi
-- (2026-09-25).
--
-- To'g'ri juftlik: izohsiz yozuv faqat unidentified bo'lishi MUMKIN
-- (driver_id ham NULL bo'lishi shart -- 038'ning duty_events_owner'i
-- allaqachon shu juftlikni birga ushlab turadi), va yozilgan izoh ELD
-- oynasining 4..60 belgisi bo'lishi kerak.

ALTER TABLE duty_events DROP CONSTRAINT duty_events_annotation_required;

ALTER TABLE duty_events ADD CONSTRAINT duty_events_annotation_required CHECK (
  (origin = 'automatic' AND driver_id IS NOT NULL)
  OR (origin = 'unidentified' AND driver_id IS NULL)
  OR (annotation IS NOT NULL AND char_length(btrim(annotation)) BETWEEN 4 AND 60)
);

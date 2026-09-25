-- 040: haydovchining kunlik transport tekshiruvi (DVIR) -- 49 CFR 396.11.
--
-- Haydovchi har kuni boshqarayotgan transport vositasini tekshiradi va
-- hisobot to'ldiradi: tormozlar, yonish, shinalar, rul, bog'lovchi
-- qurilmalar,kupelar, olov o'chirgichlar... Hisobotda kamchilik topilsa,
-- carrier uni ta'mirlamaguncha o'sha vosita yana yo'lga chiqmaydi
-- (396.11(a)); kamchilik yo'q bo'lsa, hisobot yetkazib beriladi va
-- saqlanadi. Keyingi haydovchi avvalgi hisobotdagi kamchiliklar
-- tuzatilganini tasdiqlaydi yoki rad etadi (396.13(b)(2)) -- bu tasdiq
-- ham hisobotning o'zida yashaydi.
--
-- Simulatorda hisobot YETKAZIB BERISH paytida yoziladi -- bir run bir
-- kunlik ishning ko'rinishi (truckWear.js kunlik metrics bitta run'ni
-- kunlarga bo'lsa ham, haydovchi ko'ziga ko'rinadigan birlik YUK: yakunda
-- mashina qayerda to'xtadi, shu yerda tekshiriladi). Yozuvni delivery
-- tranzaksiyasi yozadi -- truck holati bilan bir tranzaksiyada, chunki
-- kamchilik yozuvi va truck'ning yangi odo/metrlari bitta faktning ikki
-- tomoni.
--
-- CHECK'lar lug'atni yopiq ushlaydi. Itemlar boolean -- tekshirildi/
-- tekshirilmadi emas, har biri TRUE yoki FALSE: 396.11 ro'yxatidagi
-- har bir element ko'rilgan bo'lishi shart, "ko'rilmadi" yozuvi hisobot
-- emas.

CREATE TABLE IF NOT EXISTS dvir_reports (
  id         bigserial   PRIMARY KEY,

  truck_id   text        NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  -- Hisobotni kim topshirdi va qaysi yuk uchun. Load CASCADE: yuk bekor
  -- qilinsa, tarix ham bekor -- bu dasturda yuk o'chishi kompaniya
  -- reset'inng o'zi.
  driver_id  text        NULL REFERENCES drivers(id) ON DELETE SET NULL,
  load_id    text        NULL REFERENCES loads(id)   ON DELETE CASCADE,

  -- Truck'ning yetkazish paytidagi holati -- kamchilik qayerda paydo
  -- bo'lganini o'qish uchun.
  odometer_mi integer    NOT NULL,
  location_label text    NULL,

  -- 396.11 ro'yxatining yadrosi. Har biri TRUE (yaxshi) yoki FALSE
  -- (kamchilik) -- NULL yo'q, "tekshirilmadi" hisobot emas.
  brakes_ok          boolean NOT NULL,
  lights_ok          boolean NOT NULL,
  tires_ok           boolean NOT NULL,
  steering_ok        boolean NOT NULL,
  coupling_ok        boolean NOT NULL,
  horn_ok            boolean NOT NULL,
  wipers_ok          boolean NOT NULL,
  mirrors_ok         boolean NOT NULL,
  emergency_eq_ok    boolean NOT NULL,

  -- False item'lar uchun matn. Ro'yxat bo'sh bo'lsa ham mavjud (0 ta
  -- kamchilik ham fakt) -- jsonb_array CHECK bilan.
  defects            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT dvir_defects_array CHECK (jsonb_typeof(defects) = 'array'),

  -- 396.11(a): kamchilik bor bo'lsa, ta'mirlanmagunyar yangi haydovchi
  -- uni tasdiqlamasin. Bayroq delivery paytida o'rnatiladi va
  -- 396.13 tasdig'i tomonidan o'chiriladi.
  defects_corrected  boolean NOT NULL DEFAULT false,

  -- 396.13(b)(2): keyingi haydovchining tasdig'i. NULL -- hali kimdir
  -- bu truck'ni qabul qilmagan.
  certified_by_driver_id  text NULL REFERENCES drivers(id) ON DELETE SET NULL,
  certified_at            timestamptz NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dvir_odometer CHECK (odometer_mi >= 0),
  CONSTRAINT dvir_defects_need_correction CHECK (
    defects_corrected = true OR jsonb_array_length(defects) = 0
  )
);

-- "Shu truck'ning oxirgi hisoboti" -- TruckDetail va refuel/assign
-- ekranlarida ko'rsatiladigan yozuv, va 396.13 tasdig'i shu yozuvga
-- qarshi boradi.
CREATE INDEX IF NOT EXISTS idx_dvir_truck_recent
  ON dvir_reports (truck_id, created_at DESC);

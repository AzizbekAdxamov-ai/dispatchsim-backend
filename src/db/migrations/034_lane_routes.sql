-- 034: haqiqiy yo'l geometriyasi -- xaritadagi to'g'ri chiziq o'rniga.
--
-- Hozircha tracking.js har bir yukni ikkita shahar orasidagi katta doira
-- yoyi (great-circle) bo'ylab chizadi -- position.js'ning o'z izohi aytib
-- turganidek, "bu haydovchi yurgan shosse emas, bu xarita uchun halol
-- o'rta nuqta". Bu jadval OSRM (router.project-osrm.org, ochiq demo server)
-- dan olingan haqiqiy yo'l geometriyasini keshlaydi -- shahar juftligi bir
-- marta so'raladi, keyin bazadan o'qiladi. OSRM'ning o'zi 429/aloqa
-- xatolariga ochiq bir jamoat xizmati -- keshlamasdan har poll'da (10s)
-- qayta so'rash uni bosib qo'yar edi.
--
-- src/modules/routing/ shu jadval ustida ishlaydi: osrm.js tashqi
-- chaqiruv+parsing, routing.repository.js/routing.sql.js o'qish-yozish,
-- routing.service.js ikkalasini bog'laydi (bor bo'lsa bazadan, bo'lmasa
-- OSRM'dan + saqlab qo'yadi).

CREATE TABLE IF NOT EXISTS lane_routes (
  id                 bigserial   PRIMARY KEY,

  -- Yo'nalish shaharlar bo'yicha, load kabi -- lane_routes bitta yukka
  -- emas, BUTUN shahar juftligiga tegishli (OSRM javobi origin/destination
  -- koordinatalaridan hisoblanadi, aynan yukdan emas), shuning uchun bir
  -- marta so'ralgan yo'nalish shu juftlikdagi har qanday keyingi yuk uchun
  -- ham ishlaydi -- load_id FK emas, aynan shu sabab bilan.
  origin_city        text        NOT NULL,
  origin_state       text        NOT NULL,
  destination_city   text        NOT NULL,
  destination_state  text        NOT NULL,

  -- OSRM alternatives=true bilan bir nechta marshrut qaytaradi (kuzatilgan:
  -- New Orleans -> Seattle uchun ikkitasini berdi). 0 -- asosiy (eng qisqa/
  -- tez) marshrut, OSRM javobidagi routes[] massiv tartibi bo'yicha.
  -- Yuqori chegara 2: OSRM demo serveri kuzatuvda ko'pi bilan 3 ta variant
  -- qaytardi (index 0..2) -- bu sehrli son emas, shu haqiqiy javobdan.
  alternative_index  smallint    NOT NULL,

  -- [[lon,lat], [lon,lat], ...] -- OSRM'ning o'zi geometries=geojson bilan
  -- shu tartibda qaytaradi (lon avval, position.js'dagi kabi emas -- u yerda
  -- {lat,lon} obyekt, bu yerda GeoJSON [lon,lat] juftligi, chalkashmasin
  -- deb routing/osrm.js'da alohida izohlangan).
  geometry           jsonb       NOT NULL,

  -- Butun mil/daqiqa -- loyihadagi boshqa hamma masofa/vaqt ustuni kabi
  -- (distance_mi, weight_lbs...) butun son, kasr aniqligi bu yerda ham
  -- soxta aniqlik bo'lardi.
  --
  -- Yuqori chegara HISOBLANGAN, o'ylab topilmagan:
  --   - Yopiq CITIES to'plamidagi (scripts/seed/cities.js) eng uzoq juft
  --     Miami, FL <-> Seattle, WA -- 2731.6 katta-doira mili
  --     (haversineMi bilan barcha juftlikka qarshi tekshirilgan).
  --   - Bu migratsiya ko'rgan yagona haqiqiy OSRM javobi (New Orleans ->
  --     Seattle) o'z katta-doira masofasidan 1.230x (asosiy) va 1.278x
  --     (uzunroq muqobil) chiqdi -- yo'l haqiqatda to'g'ri chiziqdan
  --     shuncha uzunroq.
  --   - 2731.6 * 1.45 = 3961 -- kuzatilgan ~1.28x dan sezilarli zaxira
  --     bilan, yopiq to'plamdagi ENG UZOQ yo'nalishning haqiqatan
  --     aylanma muqobil marshrutini ham qamrab oladi. Yaxlitlab 4000.
  --
  -- loads_distance (007-migratsiya) SHARTNOMA milini 3500 bilan cheklaydi
  -- -- bu BOSHQA raqam (position.js'da distance_mi shartnoma sonicha
  -- qoladi, yo'l geometriyasi alohida maydon sifatida chiqadi -- pastga
  -- qara), va yo'l haqiqatda undan uzunroq bo'lishi tabiiy: yo'llar
  -- shaharlar orasidagi to'g'ri chiziq emas.
  distance_mi        integer     NOT NULL,
  duration_min       integer     NOT NULL,

  -- Masalan {I-45} yoki {I-40,I-25,I-80} -- osrm.js legs[].steps[].ref'dan
  -- eng ko'p masofa bosib o'tgan bir nechtasini oladi (sabab shu faylda).
  road_refs          text[]      NOT NULL DEFAULT '{}',

  -- Qachon OSRM'dan olingani -- yo'l tarmog'i o'zgarishi mumkin, lekin
  -- bugun buni yangilaydigan hech narsa yo'q (bu keyingi topshiriq); shu
  -- ustun hozirdanoq "bu qachon so'ralgan" degan faktni saqlab qo'yadi.
  fetched_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lane_routes_state_codes CHECK (
    origin_state ~ '^[A-Z]{2}$' AND destination_state ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT lane_routes_alt_range CHECK (alternative_index BETWEEN 0 AND 2),
  CONSTRAINT lane_routes_distance_range CHECK (distance_mi > 0 AND distance_mi <= 4000),
  CONSTRAINT lane_routes_duration_positive CHECK (duration_min > 0),
  -- loads.accessorials'dagi (007) bilan bir xil naqsh: ustun jsonb, lekin
  -- shakli tasodifiy emas -- OSRM'ning coordinates massivi bo'lishi kerak.
  CONSTRAINT lane_routes_geometry_array CHECK (jsonb_typeof(geometry) = 'array'),

  -- Bitta shahar juftligi, bitta variant raqami -- bitta qator. Takroriy
  -- yozuvni CHEGARA to'xtatadi, eslab qolish emas (userRoles.repository.js
  -- va driver_settlements'dagi bir xil naqsh): routing.repository.js'ning
  -- saveRoutes() ON CONFLICT DO NOTHING yozadi, shu indeksga tayanib.
  CONSTRAINT lane_routes_unique UNIQUE (
    origin_city, origin_state, destination_city, destination_state, alternative_index
  )
);

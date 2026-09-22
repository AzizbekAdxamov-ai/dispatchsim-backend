-- 037: haydovchining ish vaqti jurnali (ELD) -- va to'xtash rejasining
-- natijasi endi faqat server logida emas, yukning o'zida.
--
-- 1) duty_events
--
-- 49 CFR 395.8 va 395 Subpart B (ELD) bo'yicha haydovchi har daqiqada
-- to'rt holatdan birida bo'ladi: Off Duty, Sleeper Berth, Driving, On Duty
-- Not Driving. drivers.duty_status (005) esa boshqa, qo'polroq lug'at
-- ('driving','on-duty','resting','off') -- unda sleeper berth yo'q, va
-- 'off' "kompaniyada hozir ishlamayapti" degani (hr.service.js). Shuning
-- uchun ELD'ning o'z to'rt holati alohida jadvalda saqlanadi, drivers
-- ustunlari esa undan HOSILA qilinadi (src/constants/hosClock.js'ning
-- driverHosSnapshot'i, tick yozadi).
--
-- Vaqtlar kompaniyaning SIQILGAN kalendarida (dispatched_at/eta_at bilan
-- bir xil -- simClock.js). HOS arifmetikasi haqiqiy soatda ishlaydi;
-- o'tkazish hosClock.js'ning toHosDomain/fromHosDomain'ida, bir joyda.
--
-- Yozuvlar dispatch paytida rejadan yoziladi (stopPlan.js'ning
-- dutyTimeline'i) -- truck uzluksiz simulyatsiya qilinmaydi, stop_visits
-- (036) bilan bir xil qaror. started_at > now() bo'lgan qator hali
-- "bo'lmagan" reja: o'qishlar uni now() bilan kesadi, bekor qilish esa
-- uni o'chiradi (hech qachon yozib olinmagan narsa ELD tahriri emas).
--
-- origin / record_status / annotation -- ELD'ning o'z maydonlari (49 CFR
-- 395 Subpart B, Appendix A: "event record origin", "event record
-- status", izoh). Bu bosqichda faqat 'automatic' + 'active' yoziladi;
-- tahrirlar (4-bosqich) asl qatorni o'chirmaydi -- 'inactive-changed'
-- qiladi va yangisini qo'shadi. Qoidasi CHECK'da: avtomatik bo'lmagan
-- har bir yozuvda izoh bo'lishi shart.

CREATE TABLE IF NOT EXISTS duty_events (
  id               bigserial   PRIMARY KEY,

  driver_id        text        NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  -- Qaysi reys davomida. NULL -- reysdan tashqari yozuv (keyingi
  -- bosqichlar: haydovchi yoki carrier kiritgan).
  load_id          text        NULL     REFERENCES loads(id)   ON DELETE CASCADE,
  truck_id         text        NULL     REFERENCES trucks(id)  ON DELETE CASCADE,

  status           text        NOT NULL,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,

  -- Qayerda: marshrut boshidan necha milda, va agar shoxobchada bo'lsa --
  -- qaysi. Yo'l chetidagi dam olishda facility_id NULL (stopPlan.js'ning
  -- "roadside" holati).
  route_offset_mi  integer     NULL,
  facility_id      text        NULL     REFERENCES facilities(id),

  origin           text        NOT NULL DEFAULT 'automatic',
  record_status    text        NOT NULL DEFAULT 'active',
  annotation       text        NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT duty_events_status CHECK (
    status IN ('off-duty', 'sleeper-berth', 'driving', 'on-duty-not-driving')
  ),
  CONSTRAINT duty_events_ends_after CHECK (ended_at > started_at),
  CONSTRAINT duty_events_offset_nonneg CHECK (route_offset_mi IS NULL OR route_offset_mi >= 0),
  CONSTRAINT duty_events_origin CHECK (
    origin IN ('automatic', 'driver', 'carrier', 'unidentified')
  ),
  CONSTRAINT duty_events_record_status CHECK (
    record_status IN ('active', 'inactive-changed', 'inactive-change-requested', 'inactive-change-rejected')
  ),
  -- Qo'lda kiritilgan yoki tahrirlangan har bir yozuvning sababi bo'ladi.
  CONSTRAINT duty_events_annotation_required CHECK (
    origin = 'automatic' OR (annotation IS NOT NULL AND char_length(btrim(annotation)) >= 4)
  )
);

-- Bir haydovchi bir paytda bitta faol holatda boshlanadi -- CHEGARA bu
-- ishni qiladi, eslab qolish emas. Dispatch'dan keyingi reja qayta
-- yozilsa ham (ON CONFLICT DO NOTHING) takroriy qator paydo bo'lmaydi.
CREATE UNIQUE INDEX IF NOT EXISTS duty_events_one_active_start
  ON duty_events (driver_id, started_at)
  WHERE record_status = 'active';

-- Tick'ning so'rovi: har bir haydovchi uchun oxirgi 8 kunlik (70/8)
-- faol yozuvlar.
CREATE INDEX IF NOT EXISTS idx_duty_events_driver_window
  ON duty_events (driver_id, ended_at)
  WHERE record_status = 'active';

CREATE INDEX IF NOT EXISTS idx_duty_events_load ON duty_events (load_id);

-- 2) loads.stop_plan_*
--
-- To'xtash rejasi dispatch tranzaksiyasidan KEYIN tuziladi (dispatch.
-- service.js'ning planAndSaveStops'i) va muvaffaqiyatsiz bo'lsa ham
-- dispatch qaytarilmaydi. Shu paytgacha bu natija faqat console.error'da
-- edi -- "jimgina noto'g'ri". Endi yukning o'zida: holat va HOS faktlari
-- (masalan: "brokerning va'da qilgan oynasi qonuniy dam olishga sig'maydi"
-- yoki "bu yo'nalish uchun marshrut keshda yo'q, ETA eski hisobda qoldi").
-- NULL -- reja hali tuzilmagan (037'dan oldin dispatch qilingan yuklar).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS stop_plan_status text  NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS stop_plan_facts  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS stop_plan_at     timestamptz NULL;

ALTER TABLE loads ADD CONSTRAINT loads_stop_plan_status CHECK (
  stop_plan_status IS NULL
  OR stop_plan_status IN ('planned', 'no-route', 'no-truck', 'no-legal-arrival', 'failed')
);
ALTER TABLE loads ADD CONSTRAINT loads_stop_plan_facts_array CHECK (
  jsonb_typeof(stop_plan_facts) = 'array'
);

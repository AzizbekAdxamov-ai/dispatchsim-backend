-- Texnik xizmat yozuvlari.
-- id — uuid: hech qaysi URL yoki UI unga id boʻyicha murojaat qilmaydi
-- (FleetMaintenance.jsx da faqat React key=), shuning uchun seedda
-- toʻqnashuv xavfi butunlay yoʻq.
CREATE TABLE IF NOT EXISTS maintenance_records (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id          text        NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  service           text        NOT NULL,
  status            text        NOT NULL,
  -- Mockdagi '—' → NULL. Frontend NULL ni '—' qilib koʻrsatadi.
  due_date          date        NULL,
  due_mileage       integer     NULL,
  last_service_date date        NULL,
  cost_usd          integer     NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maint_status_valid  CHECK (status IN ('overdue','due','scheduled','done')),
  CONSTRAINT maint_service_len   CHECK (char_length(service) BETWEEN 3 AND 120),
  CONSTRAINT maint_cost          CHECK (cost_usd    IS NULL OR cost_usd    BETWEEN 0 AND 50000),
  CONSTRAINT maint_due_mileage   CHECK (due_mileage IS NULL OR due_mileage > 0),
  -- Ochiq ish uchun muddat boʻlishi shart, aks holda "overdue" nimaga nisbatan?
  CONSTRAINT maint_open_has_due  CHECK (status = 'done' OR due_date IS NOT NULL),
  -- Bajarilgan ish uchun sana va narx boʻlishi shart —
  -- FleetMaintenance.jsx oylik xarajatni aynan shundan sanaydi.
  CONSTRAINT maint_done_complete CHECK (status <> 'done' OR
                                       (last_service_date IS NOT NULL AND cost_usd IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS maint_truck_idx      ON maintenance_records (truck_id);
CREATE INDEX IF NOT EXISTS maint_status_due_idx ON maintenance_records (status, due_date);

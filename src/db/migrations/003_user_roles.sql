-- 1) user_roles: admin ochgan ish maydonlari toʻplami.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text        NOT NULL,
  granted_by uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_valid
    CHECK (role IN ('dispatcher','hr','finance','fleet-manager'))
);

-- PK (user_id, role) user_id boʻyicha qidiruvni allaqachon qoplaydi.
-- Bu indeks teskari yoʻnalish uchun: "finance ochilgan hamma talaba".
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role);

-- 2) role → active_role. RENAME: maʼlumot yoʻqolmaydi, ustun oʻchmaydi.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'users' AND column_name = 'role') THEN
    ALTER TABLE users RENAME COLUMN role TO active_role;
    ALTER TABLE users RENAME CONSTRAINT users_role_valid TO users_active_role_valid;
  END IF;
END $$;

-- 3) Mavjud qatorlarni koʻchirish. granted_at = created_at (now() emas).
INSERT INTO user_roles (user_id, role, granted_by, granted_at)
SELECT id, active_role, NULL, created_at
FROM users
WHERE active_role IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- 4) Butunlik kafolati.
--    MATCH SIMPLE: active_role NULL boʻlsa tekshirilmaydi (rolsiz talaba).
--    DEFERRABLE: rolni olib tashlash + active_role ni koʻchirish bitta
--    tranzaksiyada, tartibdan qatʼi nazar; tekshiruv COMMIT paytida.
--    ON DELETE RESTRICT ATAYLAB ISHLATILMAYDI — RESTRICT kechiktirilmaydi.
ALTER TABLE users
  ADD CONSTRAINT users_active_role_fk
  FOREIGN KEY (id, active_role) REFERENCES user_roles (user_id, role)
  DEFERRABLE INITIALLY DEFERRED;

-- 5) "Rolsiz" = user_roles da qator yoʻq. Pending filtri shu boʻyicha ishlaydi.
CREATE INDEX IF NOT EXISTS users_active_role_null_idx
  ON users (created_at DESC) WHERE active_role IS NULL;

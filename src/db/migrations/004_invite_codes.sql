CREATE TABLE IF NOT EXISTS invite_codes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text        NOT NULL UNIQUE,
  label      text        NOT NULL DEFAULT '',
  roles      text[]      NOT NULL,
  expires_at timestamptz NULL,
  max_uses   integer     NULL,
  used_count integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_by uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invite_codes_code_upper  CHECK (code = upper(code)),
  CONSTRAINT invite_codes_code_len    CHECK (char_length(code) BETWEEN 8 AND 64),
  CONSTRAINT invite_codes_label_len   CHECK (char_length(label) <= 120),
  CONSTRAINT invite_codes_roles_len   CHECK (array_length(roles, 1) BETWEEN 1 AND 4),
  CONSTRAINT invite_codes_roles_valid
    CHECK (roles <@ ARRAY['dispatcher','hr','finance','fleet-manager']::text[]),
  CONSTRAINT invite_codes_max_uses    CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT invite_codes_used_count  CHECK (used_count >= 0),
  CONSTRAINT invite_codes_uses_bound  CHECK (max_uses IS NULL OR used_count <= max_uses)
);

CREATE INDEX IF NOT EXISTS invite_codes_created_at_idx ON invite_codes (created_at DESC);

-- Rol qaysi kod orqali kelganini audit uchun bogʻlash.
-- granted_by NULL + invite_code_id NULL = migratsiya/bootstrap
-- granted_by toʻldirilgan                = admin bergan
-- invite_code_id toʻldirilgan            = invite orqali
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS invite_code_id uuid NULL
  REFERENCES invite_codes(id) ON DELETE SET NULL;

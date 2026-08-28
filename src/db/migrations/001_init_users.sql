-- users table
--
-- id is a uuid (not a serial int) so identifiers are non-sequential and safe
-- to expose in URLs/tokens without leaking signup order or row counts.
--
-- role uses a CHECK constraint against a fixed list rather than a native
-- Postgres ENUM: CHECK constraints are trivial to extend with a plain
-- migration (ALTER TABLE ... DROP/ADD CONSTRAINT), whereas altering a
-- Postgres ENUM type is more invasive and, for removing a value, effectively
-- impossible without rebuilding the type. The role list is kept in sync with
-- src/constants/roles.js by convention.
--
-- email is required to be stored lower-cased (enforced by CHECK, not just by
-- application code) so the UNIQUE constraint is a reliable case-insensitive
-- guard against duplicate accounts, regardless of which layer writes rows.
CREATE TABLE IF NOT EXISTS users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  name          text        NOT NULL,
  company       text        NOT NULL DEFAULT '',
  role          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_format    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_email_len       CHECK (char_length(email) BETWEEN 3 AND 255),
  CONSTRAINT users_name_len        CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT users_company_len     CHECK (char_length(company) <= 160),
  CONSTRAINT users_role_valid      CHECK (role IN ('dispatcher','hr','finance','fleet-manager'))
);

-- Admin access control.
--
-- Admin access is modeled as a separate `is_admin` boolean column rather
-- than an extra value in `role` (e.g. adding 'admin' to the CHECK list),
-- because `role` and admin access answer two different questions:
--   - `role` is a WORK AREA — which part of the app a person's day-to-day
--     job lives in (dispatcher / hr / finance / fleet-manager).
--   - `is_admin` is a PERMISSION — whether that person may also manage
--     other users' accounts, independent of what their work area is.
-- A single-column enum can't express "this person is both a dispatcher AND
-- an administrator" without inventing composite role strings; two columns
-- can, and each stays simple and independently indexable.
--
-- `role` is changed from NOT NULL to nullable: a freshly registered user
-- has no work area assigned yet (no fake 'pending' role string — an
-- unassigned role is represented as SQL NULL, the honest way to say "not
-- set"). An administrator assigns a real role afterward via
-- PATCH /admin/users/:id.
--
-- The existing `users_role_valid` CHECK constraint
-- (`role IN ('dispatcher','hr','finance','fleet-manager')`) is deliberately
-- left untouched. Per SQL's three-valued logic, `NULL IN (...)` evaluates
-- to NULL rather than false, and a CHECK constraint only rejects a row when
-- its expression evaluates to false — NULL is treated as passing. So once
-- the NOT NULL constraint is dropped, a NULL role automatically satisfies
-- the existing CHECK with no rewrite needed; the constraint still rejects
-- any non-NULL value that isn't one of the four known role keys.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;

-- Partial index: only admin rows are ever looked up by this flag (the
-- admin user list, the "last admin" guard), and admins are expected to be
-- a small minority of rows, so indexing only `WHERE is_admin` keeps the
-- index small instead of indexing every non-admin row too.
CREATE INDEX IF NOT EXISTS users_is_admin_idx ON users (is_admin) WHERE is_admin;

-- Supports the admin user list's default sort (newest signups first)
-- without a full-table sort on every page load.
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);

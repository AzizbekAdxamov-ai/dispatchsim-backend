-- 076: invoice sent/reminder marks + temporary-password flag (2026-11-12).
-- invoice_sent_at / invoice_reminded_at are records only: payment still runs
-- off invoice_due_at (set at delivery) and the tick -- neither column is read
-- by claimDueInvoices/markInvoicePaid.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS invoice_sent_at timestamptz NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS invoice_reminded_at timestamptz NULL;
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_invoice_sent_after_delivery;
ALTER TABLE loads ADD CONSTRAINT loads_invoice_sent_after_delivery
  CHECK (invoice_sent_at IS NULL OR delivered_at IS NOT NULL);
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_invoice_reminded_after_sent;
ALTER TABLE loads ADD CONSTRAINT loads_invoice_reminded_after_sent
  CHECK (invoice_reminded_at IS NULL OR invoice_sent_at IS NOT NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_must_change boolean NOT NULL DEFAULT false;

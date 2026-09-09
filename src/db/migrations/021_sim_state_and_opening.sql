-- 021: a place to keep the tick's own bookkeeping, and an opening balance
-- that exists without running a localhost-only script.
--
-- Two problems, both found by audit on 2026-09-08.
--
-- ONE. Interest was billed for time the account had not been negative.
-- chargeInterest() read "when did I last charge interest" from the ledger
-- itself, and no row is written while the balance is healthy -- so the
-- watermark stood still for as long as the company was solvent, and the
-- first dip into the credit line was charged for every simulated day since
-- the last charge. A student who played profitably for an hour and then
-- bought a truck was billed thirty simulated days of interest for a debt
-- two minutes old: $148 instead of $5, and $3,551 on a server left up
-- overnight. Interest needs a clock that keeps moving whether or not it
-- has anything to bill, and the ledger cannot be that clock, because a
-- zero-dollar row is forbidden by ledger_amount_nonzero.
--
-- TWO. The opening balance was written only by scripts/reset-company.js,
-- which refuses any host that is not localhost. A migrated database
-- therefore started at zero while the API kept reporting a $200,000
-- opening balance to the client, and no truck over the credit line could
-- ever be bought.

CREATE TABLE IF NOT EXISTS sim_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The opening balance, if and only if the ledger has never had one.
-- cash_ledger_one_opening (migration 019) makes a second one impossible
-- anyway; the WHERE keeps a re-run from raising instead of doing nothing.
INSERT INTO cash_ledger (kind, amount_usd, description)
SELECT 'opening', 200000, 'Opening balance'
 WHERE NOT EXISTS (SELECT 1 FROM cash_ledger WHERE kind = 'opening');

-- The interest clock starts when the company does.
INSERT INTO sim_state (key, value)
SELECT 'interest',
       jsonb_build_object(
         'lastAt', to_char(coalesce(
           (SELECT occurred_at FROM cash_ledger WHERE kind = 'opening'), now()
         ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'accruedUsd', 0
       )
 WHERE NOT EXISTS (SELECT 1 FROM sim_state WHERE key = 'interest');

-- ---------------------------------------------------------------------
-- Delivered loads that can never be paid
-- ---------------------------------------------------------------------
-- Migration 019 added invoice_due_at nullable with no backfill, and the
-- seed generator writes delivered loads without it. claimDueInvoices
-- requires the column to be set, so those invoices are never collected --
-- while getReceivables counts every delivered-and-unpaid load, so the
-- Cash page shows money owed that no tick will ever bring in, and can
-- never show it as overdue either (NULL fails invoice_due_at <= now()).
--
-- Backfilled on the compressed calendar, the same conversion the tick
-- uses: one simulated day = two real minutes = 120 seconds.
UPDATE loads
   SET invoice_due_at = delivered_at + make_interval(secs =>
         CASE payment_terms
           WHEN 'quickpay' THEN 2  * 120
           WHEN 'net15'    THEN 15 * 120
           WHEN 'net30'    THEN 30 * 120
           WHEN 'net45'    THEN 45 * 120
           WHEN 'net60'    THEN 60 * 120
           ELSE 30 * 120
         END)
 WHERE delivered_at IS NOT NULL
   AND invoice_paid_at IS NULL
   AND invoice_due_at IS NULL;

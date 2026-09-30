-- The opening balance moves from $250,000 back to $200,000.
--
-- Azizbek, 2026-09-30: the company restarts as a one-truck, one-driver
-- operation -- Grace Lindqvist, reachable through the Telegram bot -- and
-- the opening purse moves with it.
--
-- The same shape migration 031 used, for the same reason: the opening row
-- is corrected in place. cash_ledger_one_opening allows exactly one
-- 'opening' row, so there is nothing to insert and nothing to delete --
-- the amount on the row that is already there is updated, and the
-- description records which figure it now carries. Deleting and
-- re-inserting would have broken every foreign key and every running
-- total that referenced it.
--
-- A database with no opening row yet (a fresh one) gets nothing here;
-- scripts/fresh-start.js writes the row from OPENING_BALANCE_USD, which
-- this migration and the constant now agree on.

UPDATE cash_ledger
   SET amount_usd  = 200000,
       description = 'Opening balance'
 WHERE kind = 'opening'
   AND amount_usd <> 200000;

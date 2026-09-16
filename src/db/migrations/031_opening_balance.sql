-- The opening balance moves from $200,000 to $250,000.
--
-- Two things happen here, and the second one is the point.
--
-- ONE. Migration 021 wrote the number twice: 200000 in this SQL, and
-- OPENING_BALANCE_USD in src/constants/simClock.js. Two copies of one
-- number are two numbers, and they disagree the first time somebody
-- changes one of them. That is exactly what would have happened now.
--
-- TWO. An existing company's opening row is corrected rather than
-- replaced. cash_ledger_one_opening allows exactly one 'opening' row, so
-- there is nothing to insert and nothing to delete -- the amount on the
-- row that is already there is updated, and the description says why.
-- Deleting and re-inserting would have broken every foreign key and
-- every running total that referenced it.
--
-- A database that has no opening row yet (a fresh one) gets nothing from
-- this migration; scripts/reset-company.js writes the row from
-- OPENING_BALANCE_USD when the company is reset, so the constant is
-- still the single source.

UPDATE cash_ledger
   SET amount_usd  = 250000,
       description = 'Opening balance'
 WHERE kind = 'opening'
   AND amount_usd <> 250000;

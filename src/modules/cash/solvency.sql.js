// What the company owns and what it owes. sql-check PREPAREs each export.

// The balance sheet, in one query.
//
// ASSETS
//   receivables -- delivered loads whose invoice has not been paid. Real
//     money owed by real brokers on terms the student agreed to.
//   fleet -- what the trucks would fetch on the same market they were
//     bought from, valued by the same function that prices a listing
//     (src/constants/truckValue.js). Using the market's own number flatters
//     the company slightly, which is the right direction for a failure
//     test: it declares insolvency late rather than early.
//
// LIABILITIES
//   the negative cash balance -- what the credit line has advanced.
//   unpaid driver settlements -- wages earned and not yet paid. A company
//     is not solvent because it has stopped paying people.
//
// Deliberately NOT counted as an asset: postings on the board, loads
// booked but not delivered, or anything else that has not been earned.
// Counting work you have not done yet is how a balance sheet lies.
export const BALANCE_SHEET_SQL = `
  SELECT
    (SELECT coalesce(sum(amount_usd), 0)::int FROM cash_ledger)              AS "balanceUsd",
    (SELECT coalesce(sum(rate_usd), 0)::int FROM loads
      WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL)            AS "receivablesUsd",
    (SELECT coalesce(sum(net_usd), 0)::int FROM driver_settlements
      WHERE paid_at IS NULL)                                                 AS "unpaidWagesUsd",
    (SELECT count(*)::int FROM trucks)                                       AS "truckCount"`

// The fleet, valued row by row in JS so the market's pricing model is the
// only one that exists. A SQL copy of that arithmetic would be a second
// answer to the same question.
export const FLEET_FOR_VALUATION_SQL = `
  SELECT id, year, odometer_mi AS "odometerMi" FROM trucks`

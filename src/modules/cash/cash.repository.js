// The company's cash ledger.
//
// Every function that WRITES takes a `client` rather than using the pool:
// a ledger row must land in the same transaction as the thing it pays for.
// A truck bought without the money leaving, or money leaving without a
// truck, are both worse than the operation failing.
import { query } from '../../db/pool.js'

const LEDGER_COLUMNS = `
  id, occurred_at AS "occurredAt", kind, amount_usd AS "amountUsd",
  description, ref_type AS "refType", ref_id AS "refId"
`

// The balance IS this sum. There is no stored copy to disagree with it.
export async function getBalance(client) {
  const runner = client ?? { query }
  const result = await runner.query(
    `SELECT coalesce(sum(amount_usd), 0)::int AS balance FROM cash_ledger`,
  )
  return result.rows[0].balance
}

// Money in and money out over the whole ledger, so Finance can show what
// the balance is made of rather than just its total.
export async function getSummary() {
  const result = await query(
    `SELECT
       coalesce(sum(amount_usd), 0)::int                                AS balance,
       coalesce(sum(amount_usd) FILTER (WHERE amount_usd > 0), 0)::int  AS "totalIn",
       coalesce(sum(amount_usd) FILTER (WHERE amount_usd < 0), 0)::int  AS "totalOut",
       count(*)::int                                                    AS entries
     FROM cash_ledger`,
  )
  return result.rows[0]
}

// What is owed to the company and not yet collected -- delivered loads
// whose invoice has not been paid. Split by whether the money is late,
// because "you are owed $18,000" and "you are owed $18,000 and $11,000 of
// it is overdue" are different situations.
export async function getReceivables() {
  const result = await query(
    `SELECT
       coalesce(sum(rate_usd), 0)::int                                          AS "outstandingUsd",
       count(*)::int                                                            AS "openInvoices",
       coalesce(sum(rate_usd) FILTER (WHERE invoice_due_at <= now()), 0)::int   AS "overdueUsd"
     FROM loads
     WHERE delivered_at IS NOT NULL AND invoice_paid_at IS NULL`,
  )
  return result.rows[0]
}

export async function listEntries({ limit = 100, kind = null } = {}) {
  const result = await query(
    `SELECT ${LEDGER_COLUMNS}
       FROM cash_ledger
      WHERE ($2::text IS NULL OR kind = $2)
      ORDER BY occurred_at DESC, id DESC
      LIMIT $1`,
    [limit, kind],
  )
  return result.rows
}

// Write one row. `amountUsd` is signed -- callers pass a negative number
// for money going out, so the sign lives at the call site where the
// direction is obvious, not behind a boolean.
export async function addEntry(client, { kind, amountUsd, description, refType = null, refId = null, userId = null, occurredAt = null }) {
  const result = await client.query(
    `INSERT INTO cash_ledger (kind, amount_usd, description, ref_type, ref_id, created_by, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
     RETURNING ${LEDGER_COLUMNS}`,
    [kind, amountUsd, description, refType, refId, userId, occurredAt],
  )
  return result.rows[0]
}

// When interest was last charged. The tick charges for the time since,
// so a server that was off for an hour does not silently forgive it.
// Falls back to the opening balance -- there is no debt before that.
export async function lastInterestAt() {
  const result = await query(
    `SELECT max(occurred_at) AS at FROM cash_ledger WHERE kind = 'interest'`,
  )
  if (result.rows[0].at) return result.rows[0].at
  const opening = await query(
    `SELECT occurred_at AS at FROM cash_ledger WHERE kind = 'opening'`,
  )
  return opening.rows[0]?.at ?? null
}

// ---------------------------------------------------------------------
// sim_state — the tick's own bookkeeping (migration 021)
// ---------------------------------------------------------------------

// Interest needs a clock that keeps moving whether or not there is
// anything to bill. The ledger cannot be that clock: no row is written
// while the balance is healthy (a zero-dollar row is forbidden by
// ledger_amount_nonzero), so reading the watermark from the ledger meant
// the first dip into the credit line was charged for every simulated day
// since the LAST charge -- thirty days of interest on a debt a moment old.
export async function readInterestState(client) {
  const result = await client.query(
    `SELECT value FROM sim_state WHERE key = 'interest' FOR UPDATE`,
  )
  const v = result.rows[0]?.value
  if (!v) return null
  return { lastAt: new Date(v.lastAt), accruedUsd: Number(v.accruedUsd) || 0 }
}

export async function writeInterestState(client, { lastAt, accruedUsd }) {
  await client.query(
    `INSERT INTO sim_state (key, value, updated_at)
     VALUES ('interest', jsonb_build_object('lastAt', $1::text, 'accruedUsd', $2::numeric), now())
     ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, updated_at = now()`,
    [new Date(lastAt).toISOString(), accruedUsd],
  )
}

// Insurance keeps its own clock for the same reason interest does: the
// ledger cannot hold a zero-dollar row, so a company with no trucks would
// otherwise never advance the watermark and would be billed for the whole
// idle period the moment it bought its first tractor.
export async function readInsuranceState(client) {
  const result = await client.query(
    `SELECT value FROM sim_state WHERE key = 'insurance' FOR UPDATE`,
  )
  const v = result.rows[0]?.value
  if (!v) return null
  return { lastAt: new Date(v.lastAt), accruedUsd: Number(v.accruedUsd) || 0 }
}

export async function writeInsuranceState(client, { lastAt, accruedUsd }) {
  await client.query(
    `INSERT INTO sim_state (key, value, updated_at)
     VALUES ('insurance', jsonb_build_object('lastAt', $1::text, 'accruedUsd', $2::numeric), now())
     ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, updated_at = now()`,
    [new Date(lastAt).toISOString(), accruedUsd],
  )
}

// A truck that is off the road for maintenance still carries insurance;
// one that was never bought does not.
export async function countInsurableTrucks(client) {
  const result = await client.query(`SELECT count(*)::int AS n FROM trucks`)
  return result.rows[0].n
}

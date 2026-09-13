// The conditions, asked of the database.
//
// Every query here is read-only and answers "is this true right now". None
// of them writes an alert row, because a stored alert is a copy of a fact
// that can disagree with the fact -- the same argument that keeps the cash
// balance out of a column and in SUM(cash_ledger.amount_usd).
//
// Each query is small and separate rather than one clever UNION. They run
// concurrently, they fail independently, and when one of them is wrong it
// is wrong on its own.

import { query } from '../../db/pool.js'
import { LEAVING_SOON_FRACTION } from './alerts.catalog.js'
import * as SQL from './alerts.sql.js'

// Loads past the promise, and loads heading that way. Both come from
// status, which the tick maintains -- markLate is the only writer and it
// compares eta_at against promised_eta_at, the same compressed clock.
export async function lateLoads() {
  const result = await query(
    SQL.LATE_LOADS_SQL,
  )
  return result.rows
}

// Booked, not dispatched. loads_pending_clean guarantees 'neutral' means
// no driver and no truck, so the status alone is the whole condition.
export async function unassignedLoads() {
  const result = await query(
    SQL.UNASSIGNED_LOADS_SQL,
  )
  return result.rows
}

// Delivered, invoiced, past due, unpaid. daysPastDue is counted in
// SIMULATED days -- the same unit invoice_due_at is set in. Counting real
// calendar days here is what made this number 0 for every invoice ever
// written, and it read as "nothing is ever late" rather than as a bug.
export async function overdueInvoices() {
  const result = await query(
    SQL.OVERDUE_INVOICES_SQL,
  )
  return result.rows
}

// Drivers who cannot earn. Two different facts, deliberately not merged:
// a driver resting between loads is doing the right thing and simply has
// no load; a driver with no truck cannot be dispatched at all.
export async function idleDrivers() {
  const result = await query(
    SQL.IDLE_DRIVERS_SQL,
  )
  return result.rows
}

// A broker has spoken and nobody has answered. deliver_at is the delayed
// reply landing: a message still in the future has not been said yet.
export async function brokerReplies({ userId }) {
  const result = await query(
    SQL.BROKER_REPLIES_SQL,
    [userId],
  )
  return result.rows
}

// A rate was agreed and the paper is sitting there. Until it is accepted
// the load is not booked and the capacity is still on the market.
export async function unacceptedRateCons({ userId }) {
  const result = await query(
    SQL.UNACCEPTED_RATE_CONS_SQL,
    [userId],
  )
  return result.rows
}

// Applicants and listings about to leave the market.
//
// The threshold is a fraction of each row's OWN lifetime, not a number of
// minutes. Lifetimes here are derived from Little's Law and move whenever
// the drip is retuned; "15 minutes left" would quietly become wrong the
// day poolTarget changed, and nothing would say so.
export async function expiringApplicants() {
  const result = await query(
    SQL.EXPIRING_APPLICANTS_SQL,
    [LEAVING_SOON_FRACTION],
  )
  return result.rows
}

export async function expiringListings() {
  const result = await query(
    SQL.EXPIRING_LISTINGS_SQL,
    [LEAVING_SOON_FRACTION],
  )
  return result.rows
}

// --- acknowledgements --------------------------------------------------

export async function listAcks({ userId }) {
  const result = await query(
    SQL.LIST_ACKS_SQL,
    [userId],
  )
  return result.rows
}

// Acknowledging twice replaces the fingerprint rather than adding a row.
export async function ack({ userId, alertKey, fingerprint }) {
  const result = await query(
    SQL.ACK_SQL,
    [userId, alertKey, fingerprint],
  )
  return result.rows[0]
}

export async function unack({ userId, alertKey }) {
  const result = await query(
    SQL.UNACK_SQL,
    [userId, alertKey],
  )
  return result.rows[0] ?? null
}

// Road events waiting on a decision.
//
// Asked through the loadEvents repository rather than re-querying
// load_events here: one owner per table, and OPEN_EVENTS_SQL is already
// parsed by sql:check as part of that module.
export async function openRoadEvents() {
  const { openEvents } = await import('../loadEvents/loadEvents.repository.js')
  return openEvents()
}

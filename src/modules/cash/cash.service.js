// Cash: reading the account, and the one guard every spend goes through.
import { AppError } from '../../lib/errors.js'
import * as repo from './cash.repository.js'
import { CREDIT_LIMIT_USD, OPENING_BALANCE_USD } from '../../constants/simClock.js'
import { solvency, canCommitNewWork, STATES } from './solvency.service.js'

// Called before any purchase. It does NOT block a spend that merely takes
// the account negative -- that is the credit line doing its job, and the
// consequence arrives as interest on the next tick. It blocks only past
// the limit, where a real lender would simply decline.
export async function assertCanSpend(client, amountUsd) {
  const balance = await repo.getBalance(client)
  const after = balance - Math.abs(amountUsd)
  if (after < -CREDIT_LIMIT_USD) {
    throw new AppError(
      'INSUFFICIENT_FUNDS',
      `That leaves the account at $${after.toLocaleString()}, past the $${CREDIT_LIMIT_USD.toLocaleString()} credit line.`,
    )
  }
  return { balanceBefore: balance, balanceAfter: after }
}

// Can the company take on something NEW -- book a load, hire a driver,
// buy a truck?
//
// Separate from assertCanSpend, which asks "does this particular debit
// fit". This asks whether the company is in a position to commit at all.
// A booking costs nothing at the moment it is made, so assertCanSpend
// waves it through; but a company whose liabilities exceed its assets
// taking on more freight is not a decision the world offers.
//
// The refusal is the LENDER and the market, not the program protecting
// the student. Work already in transit finishes, invoices are still
// collected, and drivers are still paid when payroll runs.
export async function assertCanCommit(client, what = 'this') {
  const s = await solvency(client)
  if (canCommitNewWork(s.state)) return s

  if (s.state === STATES.INSOLVENT) {
    throw new AppError('COMPANY_INSOLVENT', {
      what,
      assetsUsd: s.assetsUsd,
      liabilitiesUsd: s.liabilitiesUsd,
      netWorthUsd: s.netWorthUsd,
      balanceUsd: s.balanceUsd,
      receivablesUsd: s.receivablesUsd,
      fleetValueUsd: s.fleetValueUsd,
      unpaidWagesUsd: s.unpaidWagesUsd,
    })
  }

  throw new AppError('CREDIT_LINE_EXHAUSTED', {
    what,
    balanceUsd: s.balanceUsd,
    creditLimitUsd: s.creditLimitUsd,
    overLimitUsd: s.overLimitUsd,
    receivablesUsd: s.receivablesUsd,
  })
}

export { solvency }

// Spend money. One place, so every debit is a real ledger row and no
// caller can quietly change the balance without leaving a trace.
export async function spend(client, { kind, amountUsd, description, refType, refId, userId }) {
  const cost = Math.abs(amountUsd)
  await assertCanSpend(client, cost)
  return repo.addEntry(client, {
    kind,
    amountUsd: -cost,
    description,
    refType,
    refId,
    userId,
  })
}

// Money in. No guard -- nothing goes wrong by being paid.
export async function receive(client, { kind, amountUsd, description, refType, refId, userId, occurredAt }) {
  return repo.addEntry(client, {
    kind,
    amountUsd: Math.abs(amountUsd),
    description,
    refType,
    refId,
    userId,
    occurredAt,
  })
}

export async function getOverview() {
  const [summary, receivables, standing] = await Promise.all([
    repo.getSummary(), repo.getReceivables(), solvency(),
  ])
  return {
    ...summary,
    ...receivables,
    creditLimitUsd: CREDIT_LIMIT_USD,
    openingBalanceUsd: OPENING_BALANCE_USD,
    // How much is left before the credit line is exhausted. The number a
    // dispatcher about to buy a $140,000 truck actually needs.
    availableUsd: summary.balance + CREDIT_LIMIT_USD,
    // Both sides of the balance sheet, so the student can check the
    // insolvency test rather than take the program's word for it.
    standing,
  }
}

export async function listEntries({ limit, kind }) {
  return { entries: await repo.listEntries({ limit, kind }) }
}

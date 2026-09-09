// Cash: reading the account, and the one guard every spend goes through.
import { AppError } from '../../lib/errors.js'
import * as repo from './cash.repository.js'
import { CREDIT_LIMIT_USD, OPENING_BALANCE_USD } from '../../constants/simClock.js'

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
  const [summary, receivables] = await Promise.all([repo.getSummary(), repo.getReceivables()])
  return {
    ...summary,
    ...receivables,
    creditLimitUsd: CREDIT_LIMIT_USD,
    openingBalanceUsd: OPENING_BALANCE_USD,
    // How much is left before the credit line is exhausted. The number a
    // dispatcher about to buy a $140,000 truck actually needs.
    availableUsd: summary.balance + CREDIT_LIMIT_USD,
  }
}

export async function listEntries({ limit, kind }) {
  return { entries: await repo.listEntries({ limit, kind }) }
}

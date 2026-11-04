// Running payroll.
//
// The point of this module is that paying drivers is something a person
// DOES. It used to happen by itself inside the delivery tick: money left
// the account, nobody chose it, nobody saw it, and a driver could never be
// owed anything. A simulator where the hard decision is made for you is
// not teaching the decision.

import { withTransaction } from '../../db/pool.js'
import * as repo from './payroll.repository.js'
import * as cashRepo from '../cash/cash.repository.js'
import { stageFor, willAcceptWork } from '../../constants/driverPay.js'

// How many settlements one run will pay. A cap so a single request cannot
// hold a long transaction open; the caller can run it again.
export const MAX_PER_RUN = 50

// Pay everything that is due, one settlement per transaction.
//
// Per settlement, not one big transaction, for the same reason the
// delivery tick works that way: if the eleventh driver's payment fails,
// the first ten stay paid. A payroll run that rolls back completely
// because of one bad row would leave a student staring at ten drivers who
// were told they were paid and were not.
//
// Cash is NOT checked first. The account is allowed to go negative -- that
// is this project's rule, consequence over blocking -- and refusing to pay
// a driver because the balance is low is precisely the situation the
// student is supposed to feel, not be protected from. Interest on the
// credit line is the consequence, and it is already charged by the tick.
// driverId: pay only that driver's due settlements (null = everyone due).
// deps is a test seam: transaction runner, payroll repo and cash repo.
export async function runPayroll(
  { userId, driverId = null } = {},
  { run = withTransaction, payrollRepo = repo, cash = cashRepo } = {},
) {
  const paid = []
  const failed = []

  for (let i = 0; i < MAX_PER_RUN; i += 1) {
    let outcome
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await run(async (client) => {
        const [next] = await payrollRepo.claimDueSettlements(client, 1, driverId)
        if (!next) return { done: true }

        // The conditional UPDATE is half of "cannot pay twice"; the unique
        // index on (kind, ref_type, ref_id) is the other half. Either one
        // alone would leave a window.
        const marked = await payrollRepo.markPaid(client, next.id)
        // Somebody else paid it between the claim and here. Skip THIS one
        // and keep going -- breaking out of the whole run would return
        // "nothing was due" while drivers were still owed, which is the
        // silent failure this module's comments say to avoid.
        if (!marked) return { skipped: true }

        await cash.addEntry(client, {
          kind: 'settlement',
          amountUsd: -marked.netUsd,
          description: `${next.driverName} — load ${marked.loadId}`,
          refType: 'settlement',
          refId: String(marked.id),
          userId: userId ?? null,
        })

        // RETURNED, not pushed. Pushing from inside the callback recorded
        // a payment before COMMIT: a connection that dropped between the
        // last statement and the commit rolled the row back while the
        // response still listed the driver as paid.
        return {
          settlement: {
            id: marked.id,
            driverId: marked.driverId,
            driverName: next.driverName,
            loadId: marked.loadId,
            netUsd: marked.netUsd,
          },
        }
      })
    } catch (err) {
      // Loudly wrong, never quietly wrong. The caller reports this to the
      // screen; a settlement that silently failed to pay would look
      // exactly like one that was never due.
      console.error('[payroll] settlement failed:', err.message)
      failed.push(err.message)
      break
    }

    if (outcome?.done) break
    if (outcome?.settlement) paid.push(outcome.settlement)
  }

  const totalUsd = paid.reduce((sum, p) => sum + p.netUsd, 0)

  // What is still owed after this run. MAX_PER_RUN caps a single run, so
  // without this the button could say "Run payroll — $18,400", pay part of
  // it, and leave the student with no way to know the rest exists.
  const stillDue = (await payrollRepo.driverOwedAll())
    .filter((d) => d.daysOverdue != null && d.daysOverdue >= 0)
    .reduce((sum, d) => sum + d.owedUsd, 0)

  return {
    paid,
    failed,
    totalUsd,
    remainingDueUsd: stillDue,
    balanceUsd: await cash.getBalance(),
  }
}

// Who is owed what, with the stage each driver is at. The stage is derived
// here rather than stored: a column would have to be recomputed on every
// payment and every tick, and a stale one would have a driver refusing
// work for money they had already been paid.
export async function listOwed() {
  const rows = await repo.driverOwedAll()
  return rows.map((r) => {
    const stage = stageFor(r.daysOverdue)
    return { ...r, stage, willWork: willAcceptWork(stage) }
  })
}

export async function listSettlements() {
  const settlements = await repo.listSettlements()
  const owed = settlements
    .filter((s) => s.status !== 'paid')
    .reduce((sum, s) => sum + s.netUsd, 0)
  const due = settlements
    .filter((s) => s.status === 'overdue')
    .reduce((sum, s) => sum + s.netUsd, 0)
  return {
    settlements,
    meta: {
      // What payroll would move if it ran right now, and what is accruing
      // behind it. Two different facts; the tile used to show neither.
      owedTotalUsd: owed,
      dueNowUsd: due,
      dueNowCount: settlements.filter((s) => s.status === 'overdue').length,
    },
  }
}

// Asked at dispatch. Returns the stage so the caller can decide what the
// driver says, rather than deciding here -- refusing is a conversation,
// not an HTTP error.
export async function driverStanding(client, driverId) {
  const row = await repo.driverOwed(client, driverId)
  if (!row) return { stage: 'ok', willWork: true, owedUsd: 0, daysOverdue: null }
  const stage = stageFor(row.daysOverdue)
  return { ...row, stage, willWork: willAcceptWork(stage) }
}

// Dispatching a load, and the tick that finishes one.
//
// This is the half of the simulator that did not exist until now. A load
// created by accepting a rate confirmation sat at 'neutral' with no way
// out: nothing assigned it, nothing delivered it, nothing invoiced it. So
// cash could only ever drain. These two pieces close the loop --
// dispatch starts the clock, the tick finishes the run and pays for it.
import { withTransaction } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import * as loadsRepo from './loads.repository.js'
import * as cash from '../cash/cash.service.js'
import * as cashRepo from '../cash/cash.repository.js'

// How many loads or invoices one tick will process. The tick runs every
// 30 seconds, so a backlog drains quickly; a cap keeps one tick bounded.
const MAX_PER_TICK = 25
import {
  simDaysToSeconds,
  msToSimDays,
  interestForPeriodExact,
} from '../../constants/simClock.js'
import { TERM_DAYS } from '../../constants/paymentTerms.js'
import { FUEL_PRICE_PER_GAL, AVG_MPG, MONTHLY_INSURANCE } from '../finance/finance.constants.js'
import { settlementFor } from '../../constants/driverPay.js'

// How long the run takes, in simulated days, from the window the broker
// promised. Floored at half a day so a short local run still has a
// visible transit rather than arriving the instant it is dispatched.
export function transitDaysFor({ pickupAt, deliveryAt }) {
  const ms = new Date(deliveryAt) - new Date(pickupAt)
  const days = ms / 86400000
  return Math.max(0.5, Number.isFinite(days) ? days : 1)
}

// How the road actually goes.
//
// eta_at used to be derived straight from the promised window, so a run
// could not take longer than promised -- by construction, not by luck.
// That is why no load in the history of this project has ever reached
// 'warn' or 'crit': the Delayed tab, the at-risk tile and the on-time
// percentage were all reading a number that could only ever be 100%.
//
// Most runs go fine. Some hit weather, a shipper that loads slowly, a
// scale queue. The distribution is deliberately gentle -- a simulator
// where a fifth of loads run late teaches learned helplessness, not
// dispatch.
export const DELAY_ODDS = Object.freeze({ minor: 0.15, major: 0.05 })

export function delayFactor(rng = Math.random) {
  const roll = rng()
  if (roll < DELAY_ODDS.major) return 1.25 + rng() * 0.35   // 25-60% over
  if (roll < DELAY_ODDS.major + DELAY_ODDS.minor) return 1.05 + rng() * 0.15  // 5-20%
  return 1
}

export function fuelCostFor(distanceMi) {
  return Math.round((distanceMi / AVG_MPG) * FUEL_PRICE_PER_GAL)
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

export async function dispatchLoad({ loadId, driverId, userId }) {
  try {
    return await dispatchLoadInner({ loadId, driverId, userId })
  } catch (err) {
    // getDriverForDispatch is an unlocked SELECT, so two dispatches of two
    // different loads to the same driver both pass the pre-flight check.
    // loads_one_active_per_driver_idx (migration 007) catches the second
    // one; without this it surfaced as INTERNAL_ERROR even though the
    // right code has existed since the board was built.
    if (err.code === '23505' && err.constraint === 'loads_one_active_per_driver_idx') {
      throw new AppError('DRIVER_HAS_ACTIVE_LOAD')
    }
    throw err
  }
}

async function dispatchLoadInner({ loadId, driverId, userId }) {
  return withTransaction(async (client) => {
    const load = await loadsRepo.getLoadById(loadId, client)
    if (!load) throw new AppError('LOAD_NOT_FOUND')
    if (load.status !== 'neutral') throw new AppError('LOAD_NOT_DISPATCHABLE')

    const driver = await loadsRepo.getDriverForDispatch(client, driverId)
    if (!driver) throw new AppError('DRIVER_NOT_FOUND')
    // A driver without a truck cannot run freight. Stated plainly rather
    // than hidden behind a filtered dropdown -- the student should see
    // that hiring and buying are two separate decisions.
    if (!driver.truckId) throw new AppError('DRIVER_HAS_NO_TRUCK')
    if (driver.activeLoads > 0) throw new AppError('DRIVER_HAS_ACTIVE_LOAD')

    // The promise is what the broker was told; the ETA is what the road
    // is going to do. They are allowed to differ, and that difference is
    // the only reason a load can ever be late.
    const promisedDays = transitDaysFor(load)
    const actualDays = promisedDays * delayFactor()
    const dispatched = await loadsRepo.dispatchLoad(client, {
      loadId,
      driverId,
      truckId: driver.truckId,
      etaSeconds: simDaysToSeconds(actualDays),
      // The same window on the same clock, without the delay. This is
      // what "on time" means for this load, and it is the only thing the
      // ETA can honestly be measured against.
      promisedSeconds: simDaysToSeconds(promisedDays),
    })
    // 0 rows means something took it between the read above and here.
    if (!dispatched) throw new AppError('LOAD_NOT_DISPATCHABLE')

    await loadsRepo.setDriverDriving(client, { driverId })

    return {
      load: dispatched,
      driver: { id: driver.id, name: driver.name },
      truckId: driver.truckId,
      transitDays: actualDays,
    }
  })
}

// ---------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------
// Runs on a timer. Three jobs, each in its own transaction so one failing
// does not roll back the others: deliver what has arrived, pay what has
// come due, charge interest on the credit line.
//
// Every money event is guarded by a unique index (cash_ledger_once_per_ref
// in migration 019) as well as by the status column it reads, so running
// this twice at once cannot double-pay a load.

export async function deliverArrivedLoads() {
  const delivered = []
  // ONE TRANSACTION PER LOAD, not one per batch.
  //
  // The batch version deadlocked the whole simulator. Fuel went out
  // through cash.spend, which refuses a debit that would pass the credit
  // limit -- so a company at -$49,900 taking delivery of a 1,000-mile run
  // threw INSUFFICIENT_FUNDS, rolled back every load in the batch, and
  // took payDueInvoices() and chargeInterest() down with it, because
  // runTick awaits them in sequence. Invoices are the only income, so the
  // balance could never rise again, and the same batch failed identically
  // every thirty seconds forever.
  //
  // Two changes fix it: each load stands alone, and fuel is no longer
  // refusable. See below.
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    let handled = null
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const [load] = await loadsRepo.claimArrivedLoads(client, 1)
        if (!load) return

        const termDays = TERM_DAYS[load.paymentTerms] ?? 30
        const done = await loadsRepo.markDelivered(client, {
          loadId: load.id,
          dueSeconds: simDaysToSeconds(termDays),
        })
        if (!done) return

        // Fuel comes out on arrival, not on payment: the run cost money
        // weeks before the broker settles, and that gap is the squeeze
        // the whole cash side exists to teach.
        //
        // It goes through addEntry, NOT through cash.spend. A debit that
        // can be refused makes sense before a purchase -- you can decline
        // to buy a truck. It makes no sense afterwards: the diesel is
        // already burnt, the load is already delivered, and a simulator
        // that refuses to record a cost that has happened is lying about
        // the company's position. Going further into the credit line is
        // the correct outcome, and the interest is the consequence.
        const fuel = fuelCostFor(load.distanceMi)
        if (fuel > 0) {
          await cashRepo.addEntry(client, {
            kind: 'fuel',
            amountUsd: -fuel,
            description: `Fuel — load ${load.id}, ${load.distanceMi} mi`,
            refType: 'load',
            refId: load.id,
          })
        }

        // The driver is paid on delivery, not on collection. A real
        // carrier settles with the driver this week and waits thirty to
        // sixty days for the broker; that gap is the squeeze. Paying out
        // of the broker's money instead would quietly delete it.
        //
        // Same reasoning as fuel: this is a cost that has already been
        // incurred, so it goes through addEntry and cannot be refused.
        const pay = settlementFor(load)
        if (pay) {
          await cashRepo.addEntry(client, {
            kind: 'settlement',
            amountUsd: -pay.net,
            description: `${load.driverName} — load ${load.id}` +
              (pay.deductions > 0 ? ` (gross $${pay.gross}, deductions $${pay.deductions})` : ''),
            refType: 'load',
            refId: load.id,
          })
        }

        await loadsRepo.releaseDriver(client, { driverId: load.driverId })
        handled = { id: load.id, fuelUsd: fuel, payUsd: pay?.net ?? 0, dueIn: termDays }
      })
    } catch (err) {
      // One load that cannot be delivered must not stop the ones behind
      // it, and must not stop invoices being paid.
      console.error(`[tick] delivery failed: ${err.message}`)
      break
    }
    if (!handled) break
    delivered.push(handled)
  }
  return delivered
}

export async function payDueInvoices() {
  const paid = []
  for (let i = 0; i < MAX_PER_TICK; i += 1) {
    let handled = null
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(async (client) => {
        const [load] = await loadsRepo.claimDueInvoices(client, 1)
        if (!load) return
        const marked = await loadsRepo.markInvoicePaid(client, load.id)
        if (!marked) return

        // The invoice is the rate PLUS whatever accessorials were billed
        // on it -- detention, layover, a second stop. Finance and the
        // dashboard have always counted those as revenue; paying only
        // rate_usd meant a $100 detention charge appeared on every report
        // and arrived in the account never.
        const amount = load.rateUsd + (load.accessorialsUsd ?? 0)
        await cash.receive(client, {
          kind: 'load_payment',
          amountUsd: amount,
          description: `${load.broker} — load ${load.id} (${load.paymentTerms})`,
          refType: 'load',
          refId: load.id,
        })
        handled = { id: load.id, amountUsd: amount }
      })
    } catch (err) {
      console.error(`[tick] invoice payment failed: ${err.message}`)
      break
    }
    if (!handled) break
    paid.push(handled)
  }
  return paid
}

// Interest accrues every tick against the balance as it stands, and the
// clock advances whether or not anything is owed.
//
// The previous version read its watermark out of the ledger, and no
// interest row is written while the balance is healthy -- so the
// watermark stood still for as long as the company was solvent and the
// first dip into the credit line was billed for every simulated day since
// the last charge. Measured: an hour of profitable play then a dip to
// -$10,000 produced $148 against a true $5. Overnight it was $3,551.
//
// Fractions are carried in sim_state rather than rounded away each tick.
// Thirty seconds at -$10,000 is $1.23; rounding that up every tick would
// bill about 20% more than the rate says.
export async function chargeInterest() {
  let charged = null
  await withTransaction(async (client) => {
    const state = await cashRepo.readInterestState(client)
    if (!state) return

    const now = new Date()
    const elapsedSimDays = msToSimDays(now.getTime() - state.lastAt.getTime())
    if (elapsedSimDays <= 0) return

    const balance = await cashRepo.getBalance(client)
    // interestForPeriod returns 0 for a balance at or above zero, so a
    // solvent company accrues nothing -- but the clock still moves.
    const accrued = state.accruedUsd + interestForPeriodExact(balance, elapsedSimDays)
    const whole = Math.floor(accrued)

    if (whole >= 1) {
      await cashRepo.addEntry(client, {
        kind: 'interest',
        amountUsd: -whole,
        description: `Credit line interest at $${Math.abs(balance).toLocaleString()}`,
      })
      charged = { amountUsd: whole, balance }
    }

    await cashRepo.writeInterestState(client, {
      lastAt: now,
      accruedUsd: Number((accrued - whole).toFixed(6)),
    })
  })
  return charged
}

// Insurance, on the compressed calendar.
//
// MONTHLY_INSURANCE has been sitting in finance.constants.js since the
// cost model was written and nothing ever charged it, so the only
// recurring expense in the simulator was interest -- and a company with
// no debt had no fixed costs at all, which is the opposite of running
// trucks. It is charged per truck: insurance scales with the fleet, and a
// fleet manager who buys a fourth tractor should see the premium move.
//
// Billed in whole simulated days rather than monthly, for the same reason
// interest is: a monthly cycle is sixty real minutes and a student would
// meet it once. Daily, it is visible without being loud.
export async function chargeInsurance() {
  let charged = null
  await withTransaction(async (client) => {
    const state = await cashRepo.readInsuranceState(client)
    if (!state) return

    const now = new Date()
    const elapsedSimDays = msToSimDays(now.getTime() - state.lastAt.getTime())
    if (elapsedSimDays <= 0) return

    const trucks = await cashRepo.countInsurableTrucks(client)
    const perDay = (MONTHLY_INSURANCE / 30) * trucks
    const accrued = state.accruedUsd + perDay * elapsedSimDays
    const whole = Math.floor(accrued)

    if (whole >= 1) {
      await cashRepo.addEntry(client, {
        kind: 'insurance',
        amountUsd: -whole,
        description: `Fleet insurance — ${trucks} truck${trucks === 1 ? '' : 's'}`,
      })
      charged = { amountUsd: whole, trucks }
    }

    await cashRepo.writeInsuranceState(client, {
      lastAt: now,
      accruedUsd: Number((accrued - whole).toFixed(6)),
    })
  })
  return charged
}

// Undo a dispatch.
//
// A load sent to the wrong driver had no way back: 'ontime' led only to
// the tick, and the tick only leads to 'done'. The driver is released in
// the same transaction, or a cancel would leave them marked as running
// freight that is no longer theirs.
export async function cancelDispatch({ loadId }) {
  return withTransaction(async (client) => {
    const driverId = await loadsRepo.getLoadDriver(client, loadId)
    const cancelled = await loadsRepo.cancelDispatch(client, loadId)
    if (!cancelled) {
      // Either it does not exist, or it is already delivered -- and a
      // delivered load has money against it, which is not something an
      // UPDATE gets to undo.
      const load = await loadsRepo.getLoadById(loadId, client)
      if (!load) throw new AppError('LOAD_NOT_FOUND')
      throw new AppError('LOAD_NOT_CANCELLABLE')
    }
    await loadsRepo.releaseDriver(client, { driverId })
    return { load: cancelled }
  })
}

// A load that will not make its window, and one that already has not.
//
// 'warn' means the current ETA is past what was promised -- still moving,
// going to be late. 'crit' means the promised delivery time has come and
// gone and the freight is not there. Neither is a verdict on the
// dispatcher: they are facts about where the truck is, which is exactly
// what a dispatcher is paid to notice early.
export async function markLateLoads() {
  const marked = []
  await withTransaction(async (client) => {
    const rows = await loadsRepo.markLate(client)
    marked.push(...rows)
  })
  return marked
}

// The three stages are independent on purpose. Each one already handles
// its own failures, and this makes sure a thrown error in one can never
// stop the other two -- the failure mode that froze the whole simulator.
export async function runTick() {
  const settle = async (label, fn) => {
    try {
      return await fn()
    } catch (err) {
      console.error(`[tick] ${label} failed: ${err.message}`)
      return null
    }
  }
  const delivered = (await settle('delivery', deliverArrivedLoads)) ?? []
  const paid = (await settle('invoices', payDueInvoices)) ?? []
  const interest = await settle('interest', chargeInterest)
  const insurance = await settle('insurance', chargeInsurance)
  const late = (await settle('lateness', markLateLoads)) ?? []
  return { delivered, paid, interest, insurance, late }
}

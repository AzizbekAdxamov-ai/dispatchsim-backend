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
import * as trucksRepo from '../fleet/trucks.repository.js'
import * as metricsRepo from '../fleet/metrics.repository.js'
import * as maintenanceRepo from '../fleet/maintenance.repository.js'

// How many loads or invoices one tick will process. The tick runs every
// 30 seconds, so a backlog drains quickly; a cap keeps one tick bounded.
const MAX_PER_TICK = 25
import {
  simDaysToSeconds,
  billableSimDays,
  interestForPeriodExactTiered,
} from '../../constants/simClock.js'
import { TERM_DAYS } from '../../constants/paymentTerms.js'
import { FUEL_PRICE_PER_GAL, AVG_MPG, MONTHLY_INSURANCE } from '../finance/finance.constants.js'
import { settlementFor, SETTLEMENT_TERM_SIM_DAYS } from '../../constants/driverPay.js'
import * as payrollRepo from '../payroll/payroll.repository.js'
import * as availabilityService from '../availability/availability.service.js'
import { REASONS } from '../../constants/availabilityReasons.js'
import { postRefusal } from '../driverChat/driverChat.refusalPost.js'
import { rollEvents } from '../loadEvents/loadEvents.service.js'
import * as loadEventsRepo from '../loadEvents/loadEvents.repository.js'
import {
  gallonsFor, fuelCostForGallons, splitTankAndPump, tirePointsWorn, serviceDueMileage,
  allocateRunDays, splitGallons, walkFuelPct,
  OIL_SERVICE_INTERVAL_MI, OIL_SERVICE_LABEL,
  TIRE_LIFE_FRONT_MI, TIRE_LIFE_REAR_MI, DAILY_DISTANCE_CAP_MI,
} from '../../constants/truckWear.js'
import { SIM_TODAY_SQL } from '../fleet/fleet.sql.js'

// How long the run takes, in simulated days, from the window the broker
// promised. Floored at half a day so a short local run still has a
// visible transit rather than arriving the instant it is dispatched.
export function transitDaysFor({ pickupAt, deliveryAt }) {
  const ms = new Date(deliveryAt) - new Date(pickupAt)
  const days = ms / 86400000
  return Math.max(0.5, Number.isFinite(days) ? days : 1)
}

// delayFactor is gone, and this note is why.
//
// It rolled a load's delay at DISPATCH: eta_at was promised * factor, the
// number was decided before the truck moved, and nothing ever said what
// caused it. That was an improvement on what came before it (a load could
// not be late at all), but it left the student watching a load slide to
// 'crit' with no cause to look at and nothing to do.
//
// Delay now comes from load_events -- weather, a breakdown, detention, a
// closed road. The driver calls it in, the dispatcher chooses how to
// handle it, and eta_at moves because of that choice. See
// src/constants/loadEvents.js. About one load in five still meets
// something, the same rate delayFactor produced; the difference is that
// the fifth load now has a reason and a decision in it.

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

    // A refusal is a thing a person said, so it goes in the conversation
    // with that person rather than only into a red line under a dropdown.
    //
    // AFTER the transaction, not inside it: the dispatch transaction is
    // rolling back regardless, and a chat write enlisted in it would roll
    // back with it -- the driver would have refused and said nothing. It
    // is also fire-and-forget: failing to post the line must not change
    // what the dispatcher is told about the dispatch itself.
    if (err instanceof AppError && (err.code === 'DRIVER_REFUSED_WORK' || err.code === 'DRIVER_QUIT')) {
      await postRefusal({ userId, details: err.details, code: err.code })
        .catch((e) => console.error('[dispatch] could not post refusal to chat:', e.message))
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

    // Will this person take the load?
    //
    // Asked inside the transaction so the answer cannot be stale -- a
    // payroll run that landed a second ago has already changed it. Nothing
    // about the driver's willingness is stored in a column: a stored
    // answer would have to be recomputed on every payment and every tick,
    // and a stale one would have somebody refusing work over money they
    // had already been paid.
    //
    // The refusal is a fact about a person, not a rule the system is
    // enforcing. The dispatcher was allowed to try, and the reason arrives
    // in the driver's own words -- see the catch in dispatchLoad.
    const availability = await availabilityService.driverAvailability(client, driverId)
    // Details on this one too, or postRefusal has no driver id and the
    // person who left says nothing at all in the thread.
    if (availability.reason === REASONS.QUIT) {
      throw new AppError('DRIVER_QUIT', {
        driverId, driverName: driver.name, reason: REASONS.QUIT,
        owedUsd: availability.standing.owedUsd,
        daysOverdue: availability.standing.daysOverdue,
      })
    }
    if (!availability.available) {
      // The reason travels with the refusal. errorHandler ships details
      // for this code in production too -- see CODES_WITH_PUBLIC_DETAILS
      // -- because "not accepting work right now" without the numbers is a
      // person's decision with its reason removed.
      throw new AppError('DRIVER_REFUSED_WORK', {
        driverId,
        driverName: driver.name,
        reason: availability.reason,
        owedUsd: availability.standing.owedUsd,
        daysOverdue: availability.standing.daysOverdue,
        unpaidCount: availability.standing.unpaidCount,
        restHoursLeft: availability.restHoursLeft ?? null,
        requiredRestHours: availability.requiredRestHours ?? null,
      })
    }

    // The promise is what the broker was told; the ETA is what the road
    // is going to do. They are allowed to differ, and that difference is
    // the only reason a load can ever be late.
    // The ETA starts equal to the promise. There is nothing to know yet:
    // a run that meets nothing arrives when it said it would, and every
    // hour it slips is an event the dispatcher watched happen.
    const promisedDays = transitDaysFor(load)
    const actualDays = promisedDays
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
// What a delivered run does to the truck that pulled it
// ---------------------------------------------------------------------
//
// Q3, the shape of the money: the tank is the truck's; diesel is paid for
// where it is bought. A run burns g_lane = roadMiles / AVG_MPG gallons. The
// tank covers what it has (fromTank, free -- that diesel was bought when it
// was pumped); the LEDGER buys the rest, and the price is
// fuelCostForGallons(g_lane - fromTank). With an empty tank that figure
// equals the old fuelCostFor(distanceMi) exactly -- pinned by test -- so no
// existing cash model changes, and a topped-up tank lowers the delivery-day
// charge by the diesel already paid for. Refuel is where new diesel costs
// money, not delivery.
//
// extraMiles (a resolved event's detour) are IN: they burn fuel, wear tires
// and land on the odometer. Not counting them would make the truck's mpg =
// distance/gallons wrong for every run that detoured. But their FUEL is
// charged by loadEvents resolve() as part of the option's costUsd -- so the
// ledger's fuel line here covers the lane only (g_lane - fromTank), and
// charging detour fuel again here would bill every detour twice.
//
// Road-event miles count, the LEDGER only sees the lane's unfueled share.
//
// Idempotency: runs INSIDE the caller's transaction, after markDelivered's
// conditional UPDATE claimed the load. Zero rows from that UPDATE means this
// function is never reached a second time for the same load.
export async function applyRunToTruck(client, load) {
  const truck = await trucksRepo.lockTruckForRun(client, load.truckId)
  if (!truck) return null

  const roadMiles = load.distanceMi + (load.extraMiles ?? 0)
  if (!(roadMiles > 0)) return null

  // The tank can only cover what it holds. fuel_gallons is an integer
  // column, so fromTank is rounded once, here, and the ledger pays for
  // everything the tank did not cover -- see splitTankAndPump for the
  // gallon that used to go missing between the two.
  const laneGallons = gallonsFor(roadMiles)
  const { fromTank, ledgerGallons } = splitTankAndPump(truck.fuelGallons, laneGallons)

  // Rear tires wear faster under load -- the two lives differ and the
  // numbers below are the sourced midpoints, see truckWear.js.
  const odoBefore = truck.odometerMi
  const odoAfter = Math.min(2000000, odoBefore + roadMiles)
  const frontTirePoints = tirePointsWorn(odoBefore, odoAfter, TIRE_LIFE_FRONT_MI)
  const rearTirePoints = tirePointsWorn(odoBefore, odoAfter, TIRE_LIFE_REAR_MI)

  const run = await trucksRepo.applyRunToTruck(client, {
    truckId: load.truckId,
    roadMiles,
    gallonsFromTank: fromTank,
    frontTirePoints,
    rearTirePoints,
  })
  if (!run) return null


  // Daily telemetry: spread across sim days, capped, never losing a mile.
  // endSimDay is the sim day the run FINISHED (the day the driver arrived).
  // span is the broker's window so a 3,500-mi lane spreads over the days it
  // actually spanned; usedMilesByDay feeds the allocation so a second run
  // finishing on an already-booked sim day borrows earlier days rather than
  // breaking the 900-mi cap. The window read back is 370 sim days -- a
  // backlog deep enough that growth past it would mean a truck booked solid
  // for a simulated year, where reading further could not change the lesson.
  const spanDays = transitDaysFor({ pickupAt: load.pickupAt, deliveryAt: load.deliveryAt })
  const endSimDay = await simTodayIso(client)
  const usedByDay = await metricsRepo.usedMilesByDay(
    client, load.truckId, shiftIsoDate(endSimDay, -370), endSimDay,
  )
  const dayRows = allocateRunDays({
    roadMiles,
    endSimDay,
    spanSimDays: spanDays,
    usedByDay,
    capMi: DAILY_DISTANCE_CAP_MI,
  })
  const dayMiles = dayRows.map((r) => r.distanceMi)
  const gallons = splitGallons(dayMiles, laneGallons)
  // fuel_pct_end walks the TANK level, not the burn: the day rows record
  // where the gauge stood at each day's end, from the tank the run started
  // with.
  const tankStartGallons = truck.fuelGallons
  const fuelPctEnds = walkFuelPct(tankStartGallons, gallons, truck.fuelCapacityGal)
  await metricsRepo.addDailyMetrics(client, load.truckId,
    dayRows.map((r, i) => ({
      day: r.day,
      distanceMi: r.distanceMi,
      fuelGallons: gallons[i],
      fuelPctEnd: fuelPctEnds[i],
    })))

  // Did the odometer cross a service multiple? One 'due' row per (truck,
  // service, mileage), guarded by the unique index -- the tick retrying
  // cannot open it twice.
  const dueMileage = serviceDueMileage(odoBefore, odoAfter, OIL_SERVICE_INTERVAL_MI)
  if (dueMileage !== null) {
    await maintenanceRepo.openServiceDue(client, {
      truckId: load.truckId,
      service: OIL_SERVICE_LABEL,
      dueMileage,
      dueDate: await simTodayIso(client),
    })
  }

  // What the LEDGER owes: only the share the tank did not cover, priced at
  // the pump. Null (no truck, zero miles) falls back to the old formula at
  // the call site.
  return fuelCostForGallons(ledgerGallons)
}

// The sim clock, from the database. sim_today() (migration 032) is the
// compressed calendar's today -- a DATE on which one real minute is half a
// day. Asked through the transaction's client so every read in one delivery
// sees the same clock.
async function simTodayIso(client) {
  const result = await client.query(SIM_TODAY_SQL)
  return result.rows[0].day
}

// 'YYYY-MM-DD' shifted by whole days, in UTC. Sim days are consecutive
// calendar dates by construction (sim_day advances 120 seconds per step), so
// date arithmetic on the ISO string is sim-day arithmetic.
function shiftIsoDate(isoDay, days) {
  const d = new Date(`${isoDay}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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

        // The run happened to a TRUCK, not just to a ledger. Everything the
        // delivery writes -- odometer, tank, tires, daily rows, the service
        // flag -- lives in the same transaction as markDelivered, inside
        // the same conditional: if the tick ever retried this load, none of
        // this could run a second time, and if any part fails the delivery
        // rolls back with it and the next tick tries the whole thing again.
        // A console.error-swallowed truck update would strand the two
        // halves of one fact: a load delivered by a truck that never moved.
        // Returns the fuel the LEDGER owes (the burn the tank did not
        // cover); null when there is no truck to write to.
        const runFuelUsd = load.truckId ? await applyRunToTruck(client, load) : null

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
        //
        // What the burn IS, has changed (032): the tank pays for what it
        // can, the ledger pays for the rest. fuelCostForGallons(g_lane -
        // fromTank) comes out to exactly fuelCostFor(distanceMi) when the
        // tank is empty -- same total, pinned by test -- and less when the
        // tank covered part of the run, because that diesel was already
        // bought when it was pumped. Refuelling is where the new diesel is
        // paid for, not here.
        const fuel = runFuelUsd ?? fuelCostFor(load.distanceMi)
        if (fuel > 0) {
          await cashRepo.addEntry(client, {
            kind: 'fuel',
            amountUsd: -fuel,
            description: `Fuel — load ${load.id}, ${load.distanceMi} mi`,
            refType: 'load',
            refId: load.id,
          })
        }

        // The driver EARNS here. They are not paid here.
        //
        // This used to write straight into cash_ledger: the money left the
        // account at delivery, nobody chose to send it, and the dispatcher
        // never saw it happen. Which meant a driver could never be owed
        // anything, and a person who is never owed anything can never have
        // a grievance -- so the single hardest thing about running a small
        // carrier was quietly handled by the simulator on the student's
        // behalf.
        //
        // What is still true, and is the reason the squeeze exists: the
        // debt is incurred at DELIVERY, while the broker pays in thirty to
        // sixty days. Earning here and paying on a payroll run keeps that
        // gap and adds the decision that sits inside it.
        //
        // createSettlement is a no-op when this load already has one --
        // settlement_one_per_load, not a remembered check -- so the tick
        // retrying after a failure cannot pay a driver twice.
        const pay = settlementFor(load)
        let earned = null
        if (pay) {
          earned = await payrollRepo.createSettlement(client, {
            driverId: load.driverId,
            loadId: load.id,
            grossUsd: pay.gross,
            deductionsUsd: pay.deductions,
            netUsd: pay.net,
            dueSeconds: simDaysToSeconds(SETTLEMENT_TERM_SIM_DAYS),
          })
        }

        await loadsRepo.releaseDriver(client, { driverId: load.driverId })
        // owedUsd, not payUsd: nothing was paid. The tick's own log line
        // saying "paid $595" while the driver was still waiting would be
        // the first place a student learned to distrust it.
        handled = {
          id: load.id,
          fuelUsd: fuel,
          owedUsd: earned ? pay.net : 0,
          dueIn: termDays,
        }
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
    // Capped. Interest used to be billed from wall-clock elapsed time
    // while every other part of the simulator is event-driven and just
    // catches up once -- so a laptop closed for eight hours came back to
    // 240 simulated days of interest on a company that had hauled nothing
    // and collected nothing meanwhile. See MAX_CATCHUP_REAL_MS.
    const elapsedSimDays = billableSimDays(now.getTime() - state.lastAt.getTime())
    if (elapsedSimDays <= 0) return

    const balance = await cashRepo.getBalance(client)
    // interestForPeriod returns 0 for a balance at or above zero, so a
    // solvent company accrues nothing -- but the clock still moves.
    // Tiered. The first $50,000 is the committed line at the contract
    // rate; anything past it is an unauthorised overdraft and carries the
    // default margin. Charging one rate on a facility that had been
    // exhausted three times over was the shape of a bug, not a deal.
    const accrued = state.accruedUsd + interestForPeriodExactTiered(balance, elapsedSimDays)
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
    // Capped for the same reason as interest: the fleet is not insured
    // through a night the simulator spent switched off.
    const elapsedSimDays = billableSimDays(now.getTime() - state.lastAt.getTime())
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
      // The balance AFTER this charge, so the log can state where the
      // account actually stands rather than where it stood a moment ago.
      charged = { amountUsd: whole, trucks, balance: await cashRepo.getBalance(client) }
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
    // Read before the UPDATE: after it, the row's driver_id is already NULL
    // and the release below would have nobody to release.
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

    // Close any open road event with the cancel, in the same transaction.
    //
    // The loads row survives a cancel, so ON DELETE CASCADE never fires and
    // an open event was simply orphaned. claimArrivedLoads skips loads with
    // one, so the load could be re-dispatched, would never arrive, would
    // slide to 'crit', and nothing anywhere said why. Worse, the event was
    // still resolvable: a $1,450 tow could be charged against a truck that
    // was not on the road, which is precisely the thing the resolve path's
    // own comment promises cannot happen.
    const closed = await loadEventsRepo.closeEventsForLoad(client, loadId)

    return { load: cancelled, eventsClosed: closed.length }
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
  // Events are rolled AFTER delivery, not before. A load that has already
  // arrived should not meet a blizzard on the tick that delivers it, and
  // deliverArrivedLoads skips loads with an open event anyway -- rolling
  // first would strand a truck that was standing in the receiver's yard.
  const events = (await settle('events', () => rollEvents())) ?? []
  // Last, so a load whose ETA just moved is classified on this tick
  // rather than looking on time for another thirty seconds.
  const late = (await settle('lateness', markLateLoads)) ?? []
  return { delivered, paid, interest, insurance, events, late }
}

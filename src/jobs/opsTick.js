// The heartbeat of the company side.
//
// Every 30 real seconds it does three things: delivers loads whose ETA has
// passed and pays for their fuel, settles invoices that have come due, and
// charges interest on a negative balance. On the compressed calendar (one
// simulated day = two real minutes) that is a check roughly every quarter
// of a simulated day -- often enough that nothing sits visibly overdue,
// rare enough to be nearly free.
//
// Separate from dailyRefresh.js on purpose. That job feeds the MARKET
// once a day; this one runs the COMPANY continuously. They are different
// clocks and different failure modes -- a broken market refresh should not
// stop loads from being delivered.
import cron from 'node-cron'
import { runTick } from '../modules/loads/dispatch.service.js'

const TICK_EXPRESSION = '*/30 * * * * *'

let running = false

async function tick(reason) {
  // A tick that overruns must not stack. Everything it does is guarded by
  // unique indexes and SKIP LOCKED anyway, so this is about noise, not
  // correctness.
  if (running) return
  running = true
  try {
    const { delivered, paid, interest } = await runTick()
    if (delivered.length > 0) {
      for (const d of delivered) {
        console.log(`[opsTick] delivered ${d.id} — fuel $${d.fuelUsd}, driver $${d.payUsd}, invoice due in ${d.dueIn} days`)
      }
    }
    if (paid.length > 0) {
      const total = paid.reduce((sum, p) => sum + p.amountUsd, 0)
      console.log(`[opsTick] invoices paid: ${paid.map((p) => p.id).join(', ')} — $${total.toLocaleString()}`)
    }
    if (interest) {
      console.log(`[opsTick] interest charged $${interest.amountUsd} on a balance of $${interest.balance.toLocaleString()}`)
    }
  } catch (err) {
    // Never let a tick failure take the process down. The next one is
    // thirty seconds away and the work is idempotent.
    console.error(`[opsTick] failed (${reason}): ${err.message}`)
  } finally {
    running = false
  }
}

export function startOpsTick() {
  cron.schedule(TICK_EXPRESSION, () => tick('cron'))
  // Catch up immediately on boot: a server that was down for an hour has
  // loads that arrived and invoices that came due while it was off.
  tick('startup')
  console.log(`[opsTick] scheduled ${TICK_EXPRESSION}`)
}

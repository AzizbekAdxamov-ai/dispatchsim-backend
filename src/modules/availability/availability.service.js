// Will this driver take the load?
//
// One place, one answer, several reasons. Dispatch, the chat panel and the
// driver list all have to agree about this -- three call sites deciding it
// separately is how one screen ends up saying a driver is available while
// another refuses to send them.
//
// Every reason here is built on data something WRITES at runtime. That
// rules out most of what a real dispatcher would consider: the driver's
// location (drivers.current_location has no writer) and their safety
// record (no writer). Refusals built on those would never fire, or would
// fire forever, and either way would look exactly as correct as the
// lateness check that could not fire. When those columns get writers the
// reasons belong here.
//
// The ten-hour break is deliberately NOT a refusal here. The stop planner
// (facilities/stopPlan.js) already carries a driver's owed rest into the
// run it plans: the first thing on the new log is the rest, at the origin,
// and the legal arrival reflects it. Blocking the dispatch would hide the
// one decision a dispatcher is for -- reading the plan and the late
// arrival and deciding anyway -- and it would enforce the same fact on a
// second clock (sim hours since delivery) that the law's own clock does
// not use. Consequence over blocking: the plan shows the rest, the ETA
// pays for it.

import { query } from '../../db/pool.js'
import * as SQL from './availability.sql.js'
import * as payrollService from '../payroll/payroll.service.js'
import { REASONS } from '../../constants/availabilityReasons.js'

export { REASONS }


export async function driverAvailability(client, driverId) {
  const runner = client ?? { query }

  const standing = await payrollService.driverStanding(client, driverId)
  if (standing.stage === 'quits') {
    return { available: false, reason: REASONS.QUIT, standing }
  }
  if (!standing.willWork) {
    return { available: false, reason: REASONS.UNPAID, standing }
  }

  // The LIVE driving clock, written by the tick's syncDriverHos (037).
  // A driver whose hours are unknown (hos_remaining_min NULL -- the log
  // has never covered them) is NOT a driver at zero, and stays
  // dispatchable exactly as before this check existed. At zero the law --
  // not this program -- stops the run; the planStops block in dispatch
  // would catch it anyway, but refusing here speaks in the driver's own
  // voice while a midnight arrival would only say so after the fact.
  const hosRow = await runner.query(SQL.DRIVE_REMAINING_SQL, [driverId])
  const driveRemainingMin = hosRow.rows[0]?.driveRemainingMin == null ? null : Number(hosRow.rows[0].driveRemainingMin)
  if (driveRemainingMin != null && driveRemainingMin <= 0) {
    return {
      available: false,
      reason: REASONS.OUT_OF_HOURS,
      standing,
      driveRemainingMin,
    }
  }

  return { available: true, reason: null, standing }
}

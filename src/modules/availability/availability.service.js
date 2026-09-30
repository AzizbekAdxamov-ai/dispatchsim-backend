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
// NO hours-of-service refusal lives here -- not the ten-hour break, and
// not the eleven-hour driving clock at zero. The stop planner
// (facilities/stopPlan.js) already carries a driver's owed rest into the
// run it plans: the first thing on the new log is the rest, at the origin,
// and the legal arrival reflects it. A driver whose eleven hours are gone
// is exactly that case with the full ten hours owed rather than part of
// them -- stopPlan.test.js pins both -- so there is nothing the planner
// cannot plan, only a later arrival to read.
//
// Blocking the dispatch would hide the one decision a dispatcher is for:
// reading the plan and the late arrival and deciding anyway. Consequence
// over blocking -- the plan shows the rest, the ETA pays for it, and the
// law stops the truck on the log where it belongs rather than in a
// dropdown.

import * as payrollService from '../payroll/payroll.service.js'
import { REASONS } from '../../constants/availabilityReasons.js'

export { REASONS }


export async function driverAvailability(client, driverId) {
  const standing = await payrollService.driverStanding(client, driverId)
  if (standing.stage === 'quits') {
    return { available: false, reason: REASONS.QUIT, standing }
  }
  if (!standing.willWork) {
    return { available: false, reason: REASONS.UNPAID, standing }
  }

  return { available: true, reason: null, standing }
}

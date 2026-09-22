// Will this driver take the load?
//
// One place, one answer, several reasons. Dispatch, the chat panel and the
// driver list all have to agree about this -- three call sites deciding it
// separately is how one screen ends up saying a driver is available while
// another refuses to send them.
//
// Every reason here is built on data something WRITES at runtime. That
// rules out most of what a real dispatcher would consider: the driver's
// location (drivers.current_location has no writer), their remaining drive
// time (hours_today_min, hos_remaining_min -- no writers), their safety
// record (no writer). Refusals built on those would never fire, or would
// fire forever, and either way would look exactly as correct as the
// lateness check that could not fire. When those columns get writers the
// reasons belong here.

import { query } from '../../db/pool.js'
import * as SQL from './availability.sql.js'
import * as payrollService from '../payroll/payroll.service.js'
import { restHoursRemaining, REQUIRED_REST_HOURS } from '../../constants/hos.js'
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

  const result = await runner.query(SQL.HOURS_SINCE_LAST_DELIVERY_SQL, [driverId])
  const row = result.rows[0]

  // Number(null) is 0, not NaN and not null. Written out rather than
  // wrapped in Number() directly because that coercion would turn "has
  // never delivered anything" into "delivered this instant" -- a brand new
  // hire would be sent to bed for ten hours before their first load. This
  // is the same NULL flattening the SQL above uses a CASE to avoid; it has
  // to be avoided on this side too or the CASE bought nothing.
  const raw = row?.simHoursSinceDelivery
  const simHours = raw == null ? null : Number(raw)
  const restHoursLeft = restHoursRemaining(simHours)
  if (restHoursLeft > 0) {
    return {
      available: false,
      reason: REASONS.RESTING,
      standing,
      // Rounded UP to a tenth. Math.round sent the last quarter-second of
      // the break to 0, and the driver's own line then read "Give me 0
      // more hours, I am still in my break" -- a composed-from-numbers
      // sentence saying something no person would say. If there is time
      // left, the number has to show it.
      restHoursLeft: Math.max(0.1, Math.ceil(restHoursLeft * 10) / 10),
      requiredRestHours: REQUIRED_REST_HOURS,
      lastDeliveredAt: row?.lastDeliveredAt ?? null,
    }
  }

  // The LIVE driving clock, written by the tick's syncDriverHos (037).
  // Checked after the rest break because both answer "can this person run
  // right now" and the rest is the longer fact. A driver whose hours are
  // unknown (hos_remaining_min NULL -- the log has never covered them) is
  // NOT a driver at zero, and stays dispatchable exactly as before this
  // check existed. At zero the law -- not this program -- stops the run;
  // the planStops block in dispatch would catch it anyway, but refusing
  // here speaks in the driver's own voice while a midnight arrival would
  // only say so after the fact.
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

// SQL for driver availability. sql-check PREPAREs every export here.
//
// The sim-hours-since-delivery query used to live here too, for the
// ten-hour refusal the service no longer makes: owed rest is carried by
// the stop planner now, and a second clock for the same fact was the
// whole problem. DRIVE_REMAINING is what remains -- a live clock with a
// runtime writer.

// The driver's live 11-hour driving clock (49 CFR 395.3(a)(3)), as the
// tick's syncDriverHos writes it. NULL when the log has never covered this
// driver -- a driver whose hours are unknown is NOT a driver at zero, and
// the service keeps those apart.
export const DRIVE_REMAINING_SQL = `
  SELECT hos_remaining_min AS "driveRemainingMin"
    FROM drivers
   WHERE id = $1 AND duty_status <> 'off'`

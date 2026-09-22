// Hours of service, the one piece of it this simulator can honestly model.
//
// UPDATE (037): the full clock now exists -- src/constants/hosClock.js
// (11h / 14h / 8h-break / 60-70h / 34h restart), duty_events as the ELD
// log, and the tick's syncDriverHos writing hos_remaining_min,
// hours_today_min and hours_week_min from it. The paragraphs below
// describe how this file started and why REQUIRED_REST_HOURS lives here;
// the "no runtime writer" statement in them is history, not current.
//
// A real HOS clock tracks driving minutes, on-duty minutes, the 14-hour
// window and the 70-hour rolling limit. This project cannot model any of
// that, and the reason is worth writing down: drivers.hours_today_min,
// hours_week_min and hos_remaining_min have NO runtime writer. Nothing
// decrements them. hos_remaining_min is only ever SET to 660 when a load
// is released. A "you have 40 minutes of drive time left" warning built on
// those columns would read the same number forever -- which is exactly the
// shape of the lateness check that could never fire.
//
// What IS live is when a driver's last load delivered. That single fact
// supports one real rule, and it is a legal one rather than a number
// somebody picked:
//
//   49 CFR 395.3(a)(1) -- a property-carrying driver must have 10
//   consecutive hours off duty before driving again.
//
// So a driver who has just delivered is on their ten. That is the only HOS
// claim this file makes, and when the other columns get writers the rest
// can be added here.
export const REQUIRED_REST_HOURS = 10

// Ten hours on the compressed calendar. One simulated day is two real
// minutes, so this is fifty real seconds -- long enough to be felt as "not
// yet", short enough that a student is not sitting watching a clock.
export const REQUIRED_REST_SIM_DAYS = REQUIRED_REST_HOURS / 24

// Hours of rest still owed, given how long ago the last load delivered.
// null in means never delivered anything, which is not a driver who needs
// rest -- it is a driver who has not worked yet.
export function restHoursRemaining(simHoursSinceDelivery) {
  if (simHoursSinceDelivery == null) return 0
  return Math.max(0, REQUIRED_REST_HOURS - simHoursSinceDelivery)
}

export function isRested(simHoursSinceDelivery) {
  return restHoursRemaining(simHoursSinceDelivery) <= 0
}

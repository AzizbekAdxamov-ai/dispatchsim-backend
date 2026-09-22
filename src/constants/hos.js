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
// So a driver who has just delivered is on their ten. The stop planner
// (facilities/stopPlan.js) carries that fact into every run it plans --
// the owed rest is the first block on the new log -- and dispatch no
// longer refuses it separately on a sim-hour clock.
export const REQUIRED_REST_HOURS = 10

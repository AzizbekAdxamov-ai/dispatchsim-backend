// The clock this company runs on.
//
// Every time a person in this program says out loud -- a driver's "I'll
// be there by four", a broker's "pick up Tuesday morning" -- is on the
// operation's clock, not on the clock of whoever is reading. The
// frontend pins the same zone (utils/format.js's APP_TIMEZONE) so that a
// 13:00Z pickup reads as 08:00 on both sides of the wire.
//
// One constant, named once, so the two halves of the app cannot drift
// into two different afternoons.
export const APP_TIMEZONE = 'America/Chicago'

// "4:05 PM" on that clock. Used in prompts, where a person is speaking:
// nobody says "twenty-two hundred Zulu" to their dispatcher.
export function clockTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d)
}

// "Tue 4:05 PM" -- when the day matters as well as the hour.
export function clockDayTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d)
}

// "Fri, Oct 2, 5:06 AM" -- the day, the date and the hour, on the
// operation's clock. For anything a model is told about WHEN: a load's
// pickup and delivery, and what time it is now.
//
// Written after 2026-09-30, when the broker prompt still interpolated a
// raw Date (`${posting.pickupAt}`). A Date turned into text speaks the
// SERVER's time zone -- on Azizbek's machine "Fri Oct 02 2026 15:06:00
// GMT+0500 (Uzbekistan Standard Time)" -- while every screen in the app
// says "Fri 5:06 AM" Central. The broker told the dispatcher 15:06; the
// board said 5:06 AM; both were the same moment, ten hours apart.
export function clockDateTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d)
}

// The calendar day on the operation's clock, as a comparable string.
function clockDay(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
}

// "6:30 PM" if it is today on the operation's clock, "Thu, Oct 1, 6:30 PM"
// if it is not. How a person says a time: nobody names today's date, and
// nobody leaves out tomorrow's. A bare "6:30 PM" for an ETA that is a day
// out is a time the listener will put on the wrong day.
export function clockWhen(iso, nowIso) {
  if (!iso || !nowIso) return clockTime(iso)
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return clockDay(iso) === clockDay(nowIso) ? clockTime(iso) : clockDateTime(iso)
}

// Minutes -> how a person says them. 395 -> "6h 35m", 45 -> "45m".
export function hoursMinutes(min) {
  if (min == null || !Number.isFinite(min)) return null
  const abs = Math.max(0, Math.round(min))
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

// Which day a moment falls on, said relative to now on the operation's
// clock: "today", "tomorrow", "yesterday", "in 3 days", "2 days ago".
//
// Handed to the models next to the date itself, because they get it
// wrong when left to work it out. On 2026-10-05 a broker, given "Pickup:
// Tue, Oct 6, 11:46 AM · Delivery: Tue, Oct 6, 9:40 PM" on a Monday,
// told the carrier "delivery by 9:40 tonight" -- a delivery before its
// own pickup. The arithmetic is the code's; the sentence is the model's.
export function relativeDay(iso, nowIso) {
  if (!iso || !nowIso) return null
  if (Number.isNaN(new Date(iso).getTime()) || Number.isNaN(new Date(nowIso).getTime())) return null
  const days = Math.round((Date.parse(`${clockDay(iso)}T00:00:00Z`) - Date.parse(`${clockDay(nowIso)}T00:00:00Z`)) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 1 ? `in ${days} days` : `${-days} days ago`
}

// "Tue, Oct 6, 11:46 AM (tomorrow)".
export function clockDateTimeDay(iso, nowIso) {
  const at = clockDateTime(iso)
  if (!at) return null
  const rel = relativeDay(iso, nowIso)
  return rel ? `${at} (${rel})` : at
}

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

// Minutes -> how a person says them. 395 -> "6h 35m", 45 -> "45m".
export function hoursMinutes(min) {
  if (min == null || !Number.isFinite(min)) return null
  const abs = Math.max(0, Math.round(min))
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

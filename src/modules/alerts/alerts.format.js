// How long ago, in the units the thing actually happened in.
//
// The simulator runs two clocks and the alert text has to pick the right
// one, or it repeats the mistake that made lateness impossible in a place
// where a student would read it rather than a place where a query would.
//
//   COMPANY events -- a promise passing, an invoice ageing -- happen on the
//   compressed calendar. Finance already speaks that language: net30 means
//   thirty simulated days, and daysPastDue counts them. So a late load is
//   "3 days" late, not "6 minutes" late, and the two numbers agree.
//
//   MARKETPLACE events -- a broker answering, a listing expiring -- happen
//   in real time, because waiting for a reply is the lesson. Those are
//   minutes, and they are the minutes on the student's own clock.
//
// Getting this backwards would produce an invoice "0 days past due" beside
// an alert saying it was late an hour ago, and the student would have to
// work out which of the two lied.

import { REAL_MS_PER_SIM_DAY } from '../../constants/simClock.js'

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

// Company side: real milliseconds in, simulated days/hours out.
export function simAgo(fromIso, now = new Date()) {
  const simDays = (now - new Date(fromIso)) / REAL_MS_PER_SIM_DAY
  if (simDays < 0) return 'not yet'
  if (simDays < 1) {
    const hours = Math.max(1, Math.round(simDays * 24))
    return plural(hours, 'hour')
  }
  return plural(Math.floor(simDays), 'day')
}

// Marketplace side: the student's own wall clock.
export function realAgo(fromIso, now = new Date()) {
  const mins = (now - new Date(fromIso)) / 60000
  if (mins < 1) return 'less than a minute'
  if (mins < 60) return plural(Math.floor(mins), 'minute')
  return plural(Math.floor(mins / 60), 'hour')
}

export function place(city, state) {
  return `${city}, ${state}`
}

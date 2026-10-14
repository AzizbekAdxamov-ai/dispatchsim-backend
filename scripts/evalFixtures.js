// The made-up load the Grace evaluation hands her when the database has
// none that fits the case. Pure, so a test can check it without a model.
import { findCity, roadMiles } from './seed/cities.js'
import { AVG_HIGHWAY_MPH } from './seed/facilities.js'
import { DRIVING_LIMIT_HOURS, BREAK_AFTER_DRIVING_HOURS, BREAK_MINUTES, REQUIRED_REST_HOURS } from '../src/constants/hosClock.js'

// Cases that need a load she is not really on: ED08 (the NYC load she asked
// not to be sent to) and ED02 (an ETA question has nothing to answer
// without a load).
export const FIXTURE_LOAD_CASES = new Set(['ED02', 'ED08'])

// Hours from dispatch to arrival for a run of this length that a driver can
// legally make: the road time at the planning speed, at most 11 driving
// hours a day (the first day only what is left on her clock), a 30-minute
// break on a day that drives past 8 hours, and the 10-hour rest between
// days. An invented "8 hours" for a 2,850-mile run had Grace saying she was
// due at 12:17 PM today (ED02).
export function legalTransitHours(miles, firstDayDriveMin = DRIVING_LIMIT_HOURS * 60) {
  let left = miles / AVG_HIGHWAY_MPH
  let hours = 0
  let todayCap = Math.min(DRIVING_LIMIT_HOURS, Math.max(0, firstDayDriveMin ?? DRIVING_LIMIT_HOURS * 60) / 60)
  for (;;) {
    const drive = Math.min(left, todayCap)
    hours += drive + (drive > BREAK_AFTER_DRIVING_HOURS ? BREAK_MINUTES / 60 : 0)
    left -= drive
    if (left <= 1e-9) return hours
    hours += REQUIRED_REST_HOURS
    todayCap = DRIVING_LIMIT_HOURS
  }
}

const FALLBACK_PICKUP = { city: 'Nashville', state: 'TN' }

// The pickup is where Grace already is (her real place from the database),
// so the "empty run" is zero and nobody was sent 2,300 miles for it. Falls
// back to Nashville only when her place is not a known city.
export function nycFixtureLoad(driver, now = Date.now()) {
  const here = findCity(driver?.currentCity, driver?.currentState)
  const from = here ?? findCity(FALLBACK_PICKUP.city, FALLBACK_PICKUP.state)
  const to = findCity('New York', 'NY')
  const distanceMi = roadMiles(from, to)
  const etaAt = new Date(now + legalTransitHours(distanceMi, driver?.hosRemainingMin) * 3600e3)
  // The appointment is the first whole hour at or after the ETA: not late.
  const deliveryAt = new Date(Math.ceil(etaAt.getTime() / 3600e3) * 3600e3)
  return {
    // Six digits, like the load numbers the app issues (nextLoadId).
    id: '480217', originCity: from.city, originState: from.state,
    destinationCity: 'New York', destinationState: 'NY',
    distanceMi,
    dispatchedAt: new Date(now), etaAt, deliveryAt,
  }
}

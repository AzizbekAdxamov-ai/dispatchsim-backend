// The made-up load the Grace evaluation hands her when the database has
// none that fits the case. Pure, so a test can check it without a model.
import { findCity, roadMiles } from './seed/cities.js'

// Cases that need a load she is not really on: ED08 (the NYC load she asked
// not to be sent to) and ED02 (an ETA question has nothing to answer
// without a load).
export const FIXTURE_LOAD_CASES = new Set(['ED02', 'ED08'])

const FALLBACK_PICKUP = { city: 'Nashville', state: 'TN' }

// The pickup is where Grace already is (her real place from the database),
// so the "empty run" is zero and nobody was sent 2,300 miles for it. Falls
// back to Nashville only when her place is not a known city.
export function nycFixtureLoad(driver, now = Date.now()) {
  const here = findCity(driver?.currentCity, driver?.currentState)
  const from = here ?? findCity(FALLBACK_PICKUP.city, FALLBACK_PICKUP.state)
  const to = findCity('New York', 'NY')
  return {
    // Six digits, like the load numbers the app issues (nextLoadId).
    id: '480217', originCity: from.city, originState: from.state,
    destinationCity: 'New York', destinationState: 'NY',
    distanceMi: roadMiles(from, to),
    dispatchedAt: new Date(now - 3600e3), etaAt: new Date(now + 8 * 3600e3), deliveryAt: new Date(now + 9 * 3600e3),
  }
}

// Where a driver is, between loads and before one.
//
// Found by the 2026-10-05 external run: Grace was dispatched on a load out
// of Nashville while the system had her in Seattle, and nobody said a
// word -- not the dispatch check, not Grace. Looking for why turned up
// the bigger fact underneath: drivers.current_city / current_lat had NO
// writer. They were seeded once and never moved, so the driver said "here
// in Seattle" after any number of deliveries, and the load board measured
// every DH-O from Seattle forever. trucks.current_location had been given
// a writer on delivery (fleet.sql.js); the driver had been forgotten.
//
// Pure: rows in, facts out. The writes are loads.repository.js's.

import { findCity, roadMiles } from '../../../scripts/seed/cities.js'
import { AVG_HIGHWAY_MPH } from '../../../scripts/seed/facilities.js'

// Where a delivered load leaves its driver: the destination, as a place
// the city list knows (lat/lon included, so the board's road_miles can
// measure from it). null for a city the list does not know -- the old
// location then stands rather than being overwritten with a guess.
export function deliveredTo(load) {
  const c = findCity(load?.destinationCity, load?.destinationState)
  if (!c) return null
  return { city: c.city, state: c.state, lat: c.lat, lon: c.lon, label: `${c.city}, ${c.state}` }
}

// The empty run from where the driver is parked to a load's pickup: road
// miles (the same roadMiles the load itself is priced with) and the hours
// of driving at AVG_HIGHWAY_MPH (the same speed every planned hour uses),
// before any rest. null when either end is not a known city; 0 miles when
// the driver is already there.
export function emptyRunToPickup(from, load) {
  const a = findCity(from?.city, from?.state)
  const b = findCity(load?.originCity, load?.originState)
  if (!a || !b) return null
  const miles = roadMiles(a, b)
  return { miles, hours: miles / AVG_HIGHWAY_MPH }
}

function hoursText(h) {
  if (h < 1) return `${Math.round(h * 60)}m`
  const whole = Math.floor(h)
  const m = Math.round((h - whole) * 60)
  return m > 0 ? `${whole}h ${String(m).padStart(2, '0')}m` : `${whole}h`
}

// One dispatch-check line: how far the empty truck has to come, and
// whether that drive alone outlasts the time left before pickup. 'warn'
// then, never 'fail' -- a late pickup is a call to make with the broker,
// not a rule this screen gets to enforce. 'unknown' when the driver's
// place is not on the map; no line without a driver.
export function emptyRunCheck(driverRow, load, now = new Date()) {
  if (!driverRow) return null
  const from = { city: driverRow.currentCity, state: driverRow.currentState }
  const run = emptyRunToPickup(from, load)
  if (!run) {
    return { key: 'emptyRun', state: 'unknown', label: 'Empty miles to pickup', detail: 'Where the driver is parked is not known', cfr: null }
  }
  if (run.miles === 0) {
    return { key: 'emptyRun', state: 'ok', label: 'Empty miles to pickup', detail: `Already in ${from.city}, ${from.state}`, cfr: null }
  }
  const pickupMs = load.pickupAt ? new Date(load.pickupAt).getTime() : null
  const hoursLeft = pickupMs == null ? null : (pickupMs - now.getTime()) / 3600000
  const tooFar = hoursLeft != null && run.hours > hoursLeft
  return {
    key: 'emptyRun',
    state: tooFar ? 'warn' : 'ok',
    label: 'Empty miles to pickup',
    detail: `${run.miles.toLocaleString('en-US')} mi from ${from.city}, ${from.state} -- about ${hoursText(run.hours)} of driving at ${AVG_HIGHWAY_MPH} mph before any rest`
      + (hoursLeft == null ? '' : hoursLeft <= 0
        ? '; the pickup time has already passed'
        : `; pickup is ${hoursText(hoursLeft)} from now`),
    cfr: null,
  }
}

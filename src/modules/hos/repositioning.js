// The drive nobody logged: getting the empty truck to the next shipper.
//
// WHY THIS EXISTS
//
// An ELD records driving from the engine, not from the driver. When the
// truck moves and no driver is signed in, the record still gets written --
// with no owner. 49 CFR 395.32 makes that the carrier's problem: those
// records must be reviewed, and each one either assigned to the driver who
// actually drove it or annotated with why it is not a driver's time.
// Compliance > Unassigned HOS is that review.
//
// Until now this program produced no such record, so the screen would have
// been a permanently empty table -- which is why it was not built. The
// missing piece was not the screen; it was a truck that moves while nobody
// is logged in. This program already had one and never wrote it down:
//
//   a load is dispatched from Dallas, delivered in Chicago; the next load
//   the dispatcher takes for that truck starts in Memphis. Somebody drove
//   the empty truck from Chicago to Memphis. The planner's log starts at
//   the ORIGIN of the new load, so those 530 miles are in nobody's log.
//
// That is deadhead, it is real, and on a real ELD it shows up as
// unidentified driving whenever the driver has not signed in for it. So
// the block below is not invented behaviour -- it is behaviour this
// program was already simulating and failing to record.
//
// WHERE THE NUMBERS COME FROM
//
// Distance: cities.js's roadMiles() between where the truck last stopped
// (trucks.current_location, written on delivery) and the new load's
// origin. The same mileage function the load itself is priced with.
//
// Duration: that distance at AVG_HIGHWAY_MPH -- the same speed stopPlan.js
// plans every driving hour with. Not a second figure for the same road.
//
// The 30 minutes: 49 CFR 395.32(b) requires the carrier to review
// unidentified records "of more than 30 minutes" in a 24-hour period.
// Below that the rule asks nothing, so a record below it would be a row
// on a screen with no action attached to it and no lesson in it. Short
// repositioning moves therefore produce no record at all -- which is also
// what the rule describes.

import { roadMiles, findCity } from '../../../scripts/seed/cities.js'
import { resolveCity } from '../tracking/laneSearch.js'
import { AVG_HIGHWAY_MPH } from '../../../scripts/seed/facilities.js'
import { simDaysToMs } from '../../constants/simClock.js'

// 49 CFR 395.32(b). Literal minutes, not compressed ones: the rule is
// about a driver's day, and hosClock.js is where the two clocks meet.
export const REVIEW_THRESHOLD_MIN = 30

// "Chicago, IL" -> the closed-set city, or null.
//
// trucks.current_location is free text -- it was seeded long before it had
// a writer -- so the label is resolved against the closed set rather than
// trusted, through laneSearch.js's resolveCity: the same resolver the
// fleet map's search uses, so "chicago, il" works and a bare ambiguous
// name is refused rather than guessed at. An unresolvable label means no
// block, never an invented one.
export function cityFromLabel(label) {
  return resolveCity(typeof label === 'string' ? label : '')
}

export function labelFor(city) {
  return `${city.city}, ${city.state}`
}

// The unidentified driving block for one dispatch, or null when there is
// nothing to record: no known previous location, the truck is already at
// the shipper, or the move is under the review threshold.
//
// It ENDS at the dispatch, because that is when the load's own log begins
// -- the repositioning is what happened before it, and the two must not
// overlap on the same truck.
export function repositioningBlock({ truckLocationLabel, originCity, originState, dispatchedAt }) {
  const from = cityFromLabel(truckLocationLabel)
  const to = findCity(originCity, originState)
  if (!from || !to) return null
  // No separate "already at the shipper" guard: that is zero miles, zero
  // minutes, and the threshold below refuses it for the same reason it
  // refuses a ten-minute move -- one rule, not two.

  const dispatchedMs = new Date(dispatchedAt).getTime()
  if (!Number.isFinite(dispatchedMs)) return null

  const distanceMi = roadMiles(from, to)
  const minutes = (distanceMi / AVG_HIGHWAY_MPH) * 60
  if (minutes <= REVIEW_THRESHOLD_MIN) return null

  const startedAt = new Date(dispatchedMs - simDaysToMs(minutes / 60 / 24))
  return {
    from: labelFor(from),
    to: labelFor(to),
    distanceMi,
    minutes: Math.round(minutes),
    startedAt,
    endedAt: new Date(dispatchedMs),
  }
}

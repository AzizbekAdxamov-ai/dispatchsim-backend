// A load's own "Live tracking" panel: where the truck is and why, from the
// SAME position the map draws (position.js via shapeBoard).
//
// Before 2026-10-08 the panel's percentage was time alone -- how much of
// pickup..delivery had passed (loadTimeline.computeProgress). Load 600010
// read "100% complete" while its driver sat at the Nashville dock in open
// detention at mile 0, and the map placed the same truck at mile 0. One
// truck, two answers. This is the map's answer, said in words.
//
// Pure: a positioned board row in, facts out. No verdicts -- miles, the
// reason the truck is stopped and since when, the ETA beside the promise.
// The student draws the conclusion.
//
// The promise, not the posting's delivery appointment: a run happens on
// the compressed calendar from the moment of dispatch (dispatch.service.js,
// transitDaysFor), while pickup_at/delivery_at stay on the posting's real
// calendar. promised_eta_at is the same promise on the run's own clock --
// the one the Trip plan panel and markLate already compare against.

import { EVENT_TYPES } from '../../constants/loadEvents.js'

// state, in precedence order (the same order position.js freezes in):
//   event    an open road event -- stopped until someone answers it
//   stop     at a planned fuel/rest stop
//   arrived  at the destination, waiting for the tick to record delivery
//   moving   on the road
export function liveTracking(row, now = new Date()) {
  if (!row) return null
  const total = Number(row.distanceMi) || 0
  const fraction = Math.min(1, Math.max(0, Number(row.progress) || 0))
  const milesLeft = Math.max(0, Number(row.distanceRemainingMi) || 0)
  const milesDone = Math.max(0, total - milesLeft)

  let state = 'moving'
  let since = null
  let reason = null
  let place = null
  if (row.openEvent && row.eventOpenedAt) {
    state = 'event'
    since = row.eventOpenedAt
    reason = EVENT_TYPES[row.eventType]?.summary ?? 'Road event'
  } else if (row.currentStop) {
    state = 'stop'
    since = row.currentStop.arrivedAt
    reason = row.currentStop.reason
    place = { name: row.currentStop.facilityName, city: row.currentStop.city, state: row.currentStop.state }
  } else if (fraction >= 1) {
    state = 'arrived'
    since = row.etaAt
  }

  const etaMs = row.etaAt ? new Date(row.etaAt).getTime() : null
  const promisedMs = row.promisedEtaAt ? new Date(row.promisedEtaAt).getTime() : null
  return {
    state,
    since,
    reason,
    place,
    milesDone,
    milesTotal: total,
    fraction,
    // Minutes the ETA runs past the promise; null when within it or when
    // either time is missing. Computed here, not by the page, so the
    // number has one author.
    etaPastPromiseMin: etaMs != null && promisedMs != null && etaMs > promisedMs ? Math.round((etaMs - promisedMs) / 60000) : null,
    etaAt: row.etaAt ?? null,
    promisedEtaAt: row.promisedEtaAt ?? null,
    lat: row.lat,
    lon: row.lon,
    geometrySource: row.geometrySource,
    asOf: now.toISOString(),
  }
}

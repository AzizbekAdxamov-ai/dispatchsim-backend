// Where a load is on the road, and how to say so.
//
// Tracking used to render an empty panel: the page had no data source.
// Everything it needs exists already -- dispatched_at, eta_at, the lane's
// endpoints, and cities.js's hand-checked coordinates -- so position is
// computed, not stored. A stored position would be a second copy of a fact
// the clock already knows, and it would go stale the way every stored copy
// in this codebase eventually has.
//
// Great-circle interpolation (not great-circle *distance*): the marker sits
// on the shortest arc between the two cities at the fraction of the run the
// elapsed time implies. It is not the highway the truck drives -- there is
// no routing engine in this codebase -- but it is the honest midpoint a map
// needs, computed from real coordinates, and it moves smoothly every poll.
// Position is a visual: the numbers on the page (miles remaining, ETA) come
// from the same fraction applied to distance_mi, and the two always agree.

import { CITIES, haversineMi } from '../../../scripts/seed/cities.js'

const CITY_BY_KEY = new Map(CITIES.map((c) => [`${c.city}, ${c.state}`, c]))

// Resolve a load's lane to coordinates. Returns nulls for an endpoint the
// seed never used -- possible only for rows written before cities.js was
// the closed set, and a null pair renders as an unmapped lane rather than a
// marker silently pinned to (0, 0) in the Gulf of Guinea.
export function laneEndpoints({ originCity, originState, destinationCity, destinationState }) {
  const origin = CITY_BY_KEY.get(`${originCity}, ${originState}`) ?? null
  const destination = CITY_BY_KEY.get(`${destinationCity}, ${destinationState}`) ?? null
  return { origin, destination }
}

// Great-circle interpolation between two points, by fraction f in [0,1].
// Slerp over the unit sphere:
//   d = angular distance, A = sin((1-f)d)/sin(d), B = sin(fd)/sin(d)
//   x,y,z = normalize(A*a + B*b), back to lat/lon
// Straight lerp on lat/lon would cut a Dallas→Chicago lane through a
// different part of the country than the sphere does -- wrong by tens of
// miles mid-lane -- and a map that disagrees with its own miles is the
// exact "two screens disagree" failure this project keeps running into.
export function interpolateGreatCircle(a, b, f) {
  const toRad = Math.PI / 180
  const toDeg = 180 / Math.PI

  const lat1 = a.lat * toRad
  const lon1 = a.lon * toRad
  const lat2 = b.lat * toRad
  const lon2 = b.lon * toRad

  // Dot product of the two unit vectors.
  const cosD = Math.sin(lat1) * Math.sin(lat2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
  const d = Math.acos(Math.min(1, Math.max(-1, cosD)))

  if (d < 1e-9 || Math.abs(d - Math.PI) < 1e-9) {
    // Same point, or antipodal (no unique arc) -- degenerate lanes the
    // closed city set cannot actually produce, but a formula that returns
    // NaN on them would poison the whole payload.
    return { lat: a.lat, lon: a.lon }
  }

  const sinD = Math.sin(d)
  const wA = Math.sin((1 - f) * d) / sinD
  const wB = Math.sin(f * d) / sinD

  const x = wA * Math.cos(lat1) * Math.cos(lon1) + wB * Math.cos(lat2) * Math.cos(lon2)
  const y = wA * Math.cos(lat1) * Math.sin(lon1) + wB * Math.cos(lat2) * Math.sin(lon2)
  const z = wA * Math.sin(lat1) + wB * Math.sin(lat2)

  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
    lon: Math.atan2(y, x) * toDeg,
  }
}

// Where the load is, as fractions and raw numbers. `progress` is the
// elapsed share of the *current* ETA window; `distanceRemainingMi` follows
// the same share so the marker, the miles and the bar never disagree.
//
// F is clamped to [0,1], never extrapolated: past the ETA the truck waits
// at the receiver's city -- which is where it actually is -- instead of
// sailing off past the destination into the Atlantic the moment a road
// event pushed the ETA out. The load's lateness is stated by `late`, not
// implied by a marker in the ocean.
export function positionFor(load, now = new Date()) {
  const { origin, destination } = laneEndpoints(load)
  if (!origin || !destination) return null

  const dispatchedMs = load.dispatchedAt ? new Date(load.dispatchedAt).getTime() : null
  const etaMs = load.etaAt ? new Date(load.etaAt).getTime() : null
  if (!dispatchedMs || !etaMs || etaMs <= dispatchedMs) return null

  // An open road event freezes the truck where it actually is. eta_at only
  // moves when the dispatcher RESOLVES the event (loadEvents.service.js's
  // resolve -> extendEta) -- while it sits open, eta_at is untouched, so
  // feeding the real clock into `f` would keep sliding the marker (and
  // distanceRemainingMi) toward the destination for a truck that is
  // actually stopped on the shoulder. Clamping `now` to the moment the
  // event opened pins `f` at whatever it was the instant the truck
  // stopped, which is where the truck still is.
  //
  // `late` is deliberately NOT computed from this clamped instant: a truck
  // stopped past its ETA is still late right now, every second it sits
  // there, and the badge has to say so even though the marker itself does
  // not move. Two different "now"s for two different questions -- one
  // asks where the truck is, the other asks whether it's on time.
  const effectiveNowMs = load.eventOpenedAt
    ? Math.min(now.getTime(), new Date(load.eventOpenedAt).getTime())
    : now.getTime()

  const totalMs = etaMs - dispatchedMs
  const elapsedMs = effectiveNowMs - dispatchedMs
  const f = Math.min(1, Math.max(0, elapsedMs / totalMs))
  const late = now.getTime() > etaMs

  const point = interpolateGreatCircle(origin, destination, f)

  // Great-circle miles for the trip, and the share of the lane's CONTRACT
  // miles that share implies. distance_mi is the 1.18 road-factor figure;
  // the great-circle number is lower by construction, so scaling
  // distance_mi by f (not subtracting haversines) keeps "remaining" and
  // "total" consistent with the number the broker was quoted.
  const laneHaversineMi = haversineMi(origin, destination)
  const distanceRemainingMi = Math.max(0, Math.round(load.distanceMi * (1 - f)))

  return {
    progress: f,
    late,
    lat: Number(point.lat.toFixed(5)),
    lon: Number(point.lon.toFixed(5)),
    distanceRemainingMi,
    laneHaversineMi: Math.round(laneHaversineMi),
    // The lane's own endpoints, so the page can draw the whole route line
    // and both city dots -- not just the marker floating in space. Same
    // closed-set resolution the marker itself used.
    origin: { lat: origin.lat, lon: origin.lon },
    destination: { lat: destination.lat, lon: destination.lon },
  }
}

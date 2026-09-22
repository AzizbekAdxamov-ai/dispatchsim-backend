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

// A point along an ACTUAL route polyline, by fraction f in [0,1] of the
// route's own length -- not by index into the coordinates array.
//
// `coordinates` is OSRM's own [[lon,lat], ...] GeoJSON order (see
// routing/osrm.js's header on why that shape is kept verbatim rather than
// converted to {lat,lon} on the way into lane_routes). Segment lengths are
// real distances (haversineMi), summed into a running total, so f=0.5
// lands at the HALFWAY-BY-DISTANCE point -- critical for a route whose
// segments are wildly uneven lengths (a simplified OSRM polyline has long
// straight interstate segments and short knotted city-exit segments in the
// same route): halfway by INDEX would put the marker a few miles from the
// origin on such a route while claiming the truck is half done, because
// most of the coordinate array's entries cluster around the two cities'
// interchanges. Halfway by distance is where the truck actually is.
//
// Interpolation WITHIN a segment is a plain lat/lon lerp, not the sphere
// slerp interpolateGreatCircle() uses for the whole-lane fallback below:
// a route's own segments are short by construction (overview=simplified
// still breaks a cross-country route into many points), so the lerp error
// over a few miles is negligible -- the slerp exists because the fallback
// arc spans an entire multi-hundred-mile lane in ONE step, which a lerp
// would visibly cut through the wrong part of the country.
export function pointAlongPath(coordinates, f) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null

  const clamped = Math.min(1, Math.max(0, f))

  if (coordinates.length === 1) {
    const [lon, lat] = coordinates[0]
    return { lat, lon }
  }

  const segmentLengths = []
  let totalMi = 0
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [lon1, lat1] = coordinates[i]
    const [lon2, lat2] = coordinates[i + 1]
    const len = haversineMi({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 })
    segmentLengths.push(len)
    totalMi += len
  }

  // Every point in the polyline is the same point (zero-length route) --
  // degenerate, but real enough (an origin/destination pair OSRM still
  // routed even though every vertex collapsed) that returning NaN would be
  // worse than just answering with the one coordinate that exists.
  if (totalMi === 0) {
    const [lon, lat] = coordinates[0]
    return { lat, lon }
  }

  const targetMi = clamped * totalMi
  let coveredMi = 0
  for (let i = 0; i < segmentLengths.length; i += 1) {
    const segLen = segmentLengths[i]
    const isLastSegment = i === segmentLengths.length - 1
    if (coveredMi + segLen >= targetMi || isLastSegment) {
      const segF = segLen === 0 ? 0 : (targetMi - coveredMi) / segLen
      const [lon1, lat1] = coordinates[i]
      const [lon2, lat2] = coordinates[i + 1]
      return {
        lat: lat1 + (lat2 - lat1) * segF,
        lon: lon1 + (lon2 - lon1) * segF,
      }
    }
    coveredMi += segLen
  }

  // Unreachable given the loop above always resolves on its last
  // iteration, kept only so a future edit that breaks that invariant
  // fails loudly here instead of returning undefined to the caller.
  const [lon, lat] = coordinates[coordinates.length - 1]
  return { lat, lon }
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
//
// `routeGeometry` (optional): a lane_routes.geometry array
// ([[lon,lat], ...], OSRM's own coordinate order), the load's alternative
// 0 route joined in by tracking.repository.js. When it's there the marker
// travels pointAlongPath() -- the actual road. When it's null (an older
// load whose lane was never searched, or a lane OSRM has no route for),
// the marker falls back to interpolateGreatCircle() exactly as before --
// this parameter is additive, not a breaking change to any existing call.
// `geometrySource` on the return says which one ran, so the page can say
// so too instead of pretending every marker was always road-accurate.
//
// `load.currentStop` (optional, set by tracking.repository.js's board
// query): { lat, lon, arrivedAt, ... } for the facility the load is AT
// right now, or absent/null otherwise. When present it freezes the marker
// the same way `load.eventOpenedAt` already does -- see the precedence
// comment beside `freezeAtMs` below for which one wins when both apply.
export function positionFor(load, now = new Date(), routeGeometry = null) {
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
  // A planned stop (facilities/stopPlan.js, via stop_visits, joined in by
  // tracking.repository.js as `currentStop`) freezes the truck the same
  // way an open road event does -- at the moment it arrived -- but an
  // open event wins when both are true at once. A road event is something
  // that happened TO the run (a blowout, a DOT stop, weather) that nobody
  // planned; a stop is the run going exactly as planned. The more
  // truthful "where is the truck right now" answer, for a driver who is
  // simultaneously mid-emergency AND mid-plan, is the emergency -- so
  // eventOpenedAt's freeze point governs, and its ALREADY-EXISTING
  // computed route position is used below, not the facility's
  // coordinates.
  const freezeAtMs = load.eventOpenedAt
    ? new Date(load.eventOpenedAt).getTime()
    : (load.currentStop ? new Date(load.currentStop.arrivedAt).getTime() : null)
  const effectiveNowMs = freezeAtMs !== null
    ? Math.min(now.getTime(), freezeAtMs)
    : now.getTime()

  const totalMs = etaMs - dispatchedMs
  const elapsedMs = effectiveNowMs - dispatchedMs
  const f = Math.min(1, Math.max(0, elapsedMs / totalMs))
  const late = now.getTime() > etaMs

  // A real route beats the fallback arc whenever there is one worth
  // using. Fewer than 2 coordinates can't be interpolated (a single point,
  // or a geometry column holding something malformed) -- that's treated
  // the same as "no route", not as a crash.
  const hasRoute = Array.isArray(routeGeometry) && routeGeometry.length >= 2
  // At a facility (and not simultaneously mid-event -- see the precedence
  // comment above) the marker sits on the facility's OWN coordinates, not
  // wherever `f` projects onto the route: a stop candidate is only
  // required to be within ROUTE_CORRIDOR_MI of the route (stopPlan.js),
  // not ON it, so the two points can differ by up to that radius, and
  // showing the truck exactly where it is parked is the more honest
  // answer than showing it floating on the road beside the facility.
  const atFacility = Boolean(load.currentStop) && !load.eventOpenedAt
  const point = atFacility
    ? { lat: load.currentStop.lat, lon: load.currentStop.lon }
    : hasRoute
      ? pointAlongPath(routeGeometry, f)
      : interpolateGreatCircle(origin, destination, f)
  const geometrySource = atFacility ? 'stop' : (hasRoute ? 'route' : 'arc')

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
    // 'route' when the marker walked the real OSRM polyline, 'arc' when it
    // fell back to the great-circle arc, 'stop' when it's pinned to a
    // facility the load is currently stopped at -- see the parameter doc
    // above and the freeze-precedence comment near `freezeAtMs`.
    geometrySource,
    // The lane's own endpoints, so the page can draw the whole route line
    // and both city dots -- not just the marker floating in space. Same
    // closed-set resolution the marker itself used.
    origin: { lat: origin.lat, lon: origin.lon },
    destination: { lat: destination.lat, lon: destination.lon },
  }
}
